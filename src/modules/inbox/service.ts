import type pg from "pg";
import { z } from "zod";
import { type Queryable, queryOne, withTx } from "@/lib/db";
import { AppError, conflict, forbidden, invalid, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/http";
import { now, todayOps } from "@/lib/time";
import { type Actor, assertCan, can } from "@/modules/auth/actor";
import { type AuditActor, auditActorOf, writeAudit } from "@/modules/audit/audit";
import { isPaused } from "@/modules/automation/switches";
import { enqueueStaffNotification } from "@/modules/notifications/enqueue";
import type { FindGroundedAnswer, GroundedAnswer } from "@/modules/qa/contract";
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  type TicketCategory,
  type TicketPriority,
  acceptDueAt,
  detectLanguage,
  detectSensitiveIntent,
  extractBookingClaims,
  looksLikeAccessSecret,
  nameMatches,
  phoneDigits,
} from "./rules";
import { TICKET_TRANSITIONS } from "./labels";
import { type SendResult, sendWhatsAppText } from "./transport";

/**
 * Hộp thư hợp nhất (Trợ lý 3). Quy tắc chính:
 *   - Nhận tin idempotent: cùng connector + luồng + mã tin chỉ lưu một lần (khoá tư vấn + kiểm trước rồi ghi).
 *   - Bot KHÔNG dùng LLM: chỉ soạn nháp từ Q&A đã duyệt (có căn cứ). Tự gửi chỉ khi công tắc guest + whatsapp_guest mở.
 *   - Mã cửa / hoàn tiền / sự cố / không căn cứ ⇒ không trả lời, tạo handoff + ticket.
 *   - Người tiếp quản ⇒ bot im lặng tới khi trả lại.
 *   - Báo cho đội qua enqueueStaffNotification trong giao dịch — module này không tự gửi WhatsApp cho nhân viên.
 */

export interface InboxDeps {
  findAnswer: FindGroundedAnswer;
  send: (orgId: string, connectorId: string, toJidOrPhone: string, text: string, opts?: { maxWaitMs?: number }) => Promise<SendResult>;
}

async function defaultDeps(): Promise<InboxDeps> {
  const { findGroundedAnswer } = await import("@/modules/qa/retrieval");
  return { findAnswer: findGroundedAnswer, send: sendWhatsAppText };
}

async function resolveDeps(deps?: Partial<InboxDeps>): Promise<InboxDeps> {
  if (deps?.findAnswer && deps?.send) return deps as InboxDeps;
  const base = await defaultDeps();
  return { ...base, ...deps };
}

const BOT_AUDIT = (orgId: string): AuditActor => ({ orgId, actorType: "agent", actorId: null });

interface ConvRow {
  id: string;
  org_id: string;
  channel: string;
  connector_id: string | null;
  external_thread_id: string;
  kind: "guest" | "staff" | "group" | "unknown";
  staff_user_id: string | null;
  booking_id: string | null;
  unit_id: string | null;
  verification_level: "none" | "matched" | "verified";
  status: string;
  handled_by: "bot" | "human";
  takeover_by: string | null;
  language: string | null;
  is_demo: boolean;
}

const CONV_COLS = `id, org_id, channel, connector_id, external_thread_id, kind, staff_user_id, booking_id, unit_id, verification_level, status, handled_by, takeover_by, language, is_demo`;

async function lockConversation(tx: Queryable, orgId: string, conversationId: string): Promise<ConvRow> {
  if (!isUuid(conversationId)) throw notFound("hội thoại");
  const { rows } = await tx.query<ConvRow>(`SELECT ${CONV_COLS} FROM conversations WHERE id = $1 AND org_id = $2 FOR UPDATE`, [conversationId, orgId]);
  if (!rows[0]) throw notFound("hội thoại");
  return rows[0];
}

// ───────────────────────── Nhận tin ─────────────────────────

export interface InboundMessage {
  orgId: string;
  connectorId: string;
  channel: "whatsapp";
  /** WhatsApp: remoteJid (cá nhân `...@s.whatsapp.net`, nhóm `...@g.us`) */
  threadId: string;
  externalMessageId: string;
  /** Người gửi thực: trong nhóm là participant, ngoài nhóm là remoteJid */
  senderHandle: string | null;
  senderName: string | null;
  text: string | null;
  attachments?: { kind: string }[];
  occurredAt: Date | null;
  isDemo?: boolean;
}

export interface IngestResult {
  status: "stored" | "duplicate";
  conversationId: string;
  messageId: string | null;
  bot: BotOutcome | null;
}

export type BotOutcome =
  | { action: "skipped"; reason: "not_guest" | "human_handling" | "no_text" }
  | { action: "draft"; messageId: string; autoSend: false; pausedReason: string | null }
  | { action: "queued"; messageId: string; autoSend: true }
  | { action: "handoff"; handoffId: string; ticketId: string | null; reason: string; created: boolean };

async function findStaffByPhone(tx: Queryable, orgId: string, handle: string | null): Promise<string | null> {
  const digits = phoneDigits(handle);
  if (!digits) return null;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM users WHERE org_id = $1 AND active AND phone IS NOT NULL
        AND regexp_replace(regexp_replace(phone, '\\D', '', 'g'), '^00', '') = $2 LIMIT 2`,
    [orgId, digits],
  );
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * Khớp booking cho khách: chỉ khi mã booking + tên người đặt + ngày nhận/trả cùng khớp ĐÚNG MỘT booking.
 * Không khớp / khớp nhiều ⇒ null và không trả về bất cứ gì của booking khác.
 */
export async function matchBookingFromText(tx: Queryable, orgId: string, text: string): Promise<{ bookingId: string; unitId: string | null } | null> {
  const claims = extractBookingClaims(text);
  if (claims.refs.length === 0 || claims.dates.length === 0) return null;
  const { rows } = await tx.query<{ id: string; check_in_date: string; check_out_date: string; full_name: string | null }>(
    `SELECT b.id, b.check_in_date, b.check_out_date, g.full_name
       FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id AND g.org_id = b.org_id
      WHERE b.org_id = $1 AND upper(b.external_ref) = ANY($2::text[]) AND b.booking_status <> 'cancelled'`,
    [orgId, claims.refs],
  );
  const hits = rows.filter((b) => b.full_name && nameMatches(b.full_name, text) && (claims.dates.includes(b.check_in_date) || claims.dates.includes(b.check_out_date)));
  if (hits.length !== 1) return null;
  const units = await tx.query<{ unit_id: string }>("SELECT DISTINCT unit_id FROM booking_allocations WHERE booking_id = $1 AND org_id = $2 AND status = 'active'", [hits[0].id, orgId]);
  return { bookingId: hits[0].id, unitId: units.rows.length === 1 ? units.rows[0].unit_id : null };
}

export async function ingestInboundMessage(input: InboundMessage, deps?: Partial<InboxDeps>): Promise<IngestResult> {
  const threadId = input.threadId.trim().slice(0, 200);
  const externalId = input.externalMessageId.trim().slice(0, 200);
  if (!threadId || !externalId) throw invalid("Thiếu mã luồng hoặc mã tin.");
  const text = input.text?.slice(0, 8000) ?? null;
  const isGroup = threadId.endsWith("@g.us");

  const stored = await withTx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7350))", [`inbox|${input.connectorId}|${threadId}`]);
    const connector = await tx.query<{ id: string }>("SELECT id FROM connector_accounts WHERE id = $1 AND org_id = $2", [input.connectorId, input.orgId]);
    if (!connector.rows[0]) throw notFound("connector");

    let conv =
      (
        await tx.query<ConvRow>(`SELECT ${CONV_COLS} FROM conversations WHERE org_id = $1 AND channel = $2 AND connector_id = $3 AND external_thread_id = $4 FOR UPDATE`, [
          input.orgId,
          input.channel,
          input.connectorId,
          threadId,
        ])
      ).rows[0] ?? null;

    if (conv) {
      const dup = await tx.query("SELECT 1 FROM messages WHERE conversation_id = $1 AND external_message_id = $2", [conv.id, externalId]);
      if (dup.rows[0]) return { duplicate: true as const, conv, messageId: null };
    }

    const senderStaffId = await findStaffByPhone(tx, input.orgId, input.senderHandle ?? threadId);
    if (!conv) {
      const kind = isGroup ? "group" : senderStaffId ? "staff" : "guest";
      const { rows } = await tx.query<ConvRow>(
        `INSERT INTO conversations (org_id, channel, connector_id, external_thread_id, kind, title, contact_name, contact_handle, staff_user_id, handled_by, language, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${CONV_COLS}`,
        [
          input.orgId,
          input.channel,
          input.connectorId,
          threadId,
          kind,
          isGroup ? null : input.senderName?.slice(0, 200) ?? null,
          isGroup ? null : input.senderName?.slice(0, 200) ?? null,
          isGroup ? threadId : phoneDigits(threadId) ?? threadId,
          kind === "staff" ? senderStaffId : null,
          kind === "guest" ? "bot" : "human",
          text ? detectLanguage(text) : null,
          input.isDemo ?? false,
        ],
      );
      conv = rows[0];
    } else if (!isGroup && senderStaffId && conv.kind !== "staff") {
      // Số đã được khai là nhân viên sau khi hội thoại mở: chuyển sang hội thoại nội bộ, bot không xử lý nữa.
      await tx.query("UPDATE conversations SET kind = 'staff', staff_user_id = $2, handled_by = 'human' WHERE id = $1", [conv.id, senderStaffId]);
      conv = { ...conv, kind: "staff", staff_user_id: senderStaffId, handled_by: "human" };
    }

    const occurred = input.occurredAt && !Number.isNaN(input.occurredAt.getTime()) ? input.occurredAt : null;
    const msg = await tx.query<{ id: string }>(
      `INSERT INTO messages (org_id, conversation_id, direction, author_type, author_user_id, author_name, external_message_id, body, attachments, status, source_occurred_at)
       VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8,'received',$9) RETURNING id`,
      [
        input.orgId,
        conv.id,
        senderStaffId ? "staff" : "guest",
        senderStaffId,
        input.senderName?.slice(0, 200) ?? null,
        externalId,
        text,
        JSON.stringify(input.attachments ?? []),
        occurred,
      ],
    );
    await tx.query(
      `UPDATE conversations SET last_message_at = now(), last_inbound_at = now(), unread_count = unread_count + 1,
              status = 'open', contact_name = COALESCE(contact_name, $2), updated_at = now() WHERE id = $1`,
      [conv.id, isGroup ? null : input.senderName?.slice(0, 200) ?? null],
    );

    // Nhận diện booking cho khách từ các tin gần đây (mã + tên + ngày phải cùng khớp).
    if (conv.kind === "guest" && conv.verification_level === "none" && text) {
      const recent = await tx.query<{ body: string | null }>(
        "SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in' AND body IS NOT NULL ORDER BY created_at DESC LIMIT 5",
        [conv.id],
      );
      const match = await matchBookingFromText(tx, input.orgId, recent.rows.map((r) => r.body).join("\n"));
      if (match) {
        await tx.query("UPDATE conversations SET booking_id = $2, unit_id = $3, verification_level = 'matched' WHERE id = $1", [conv.id, match.bookingId, match.unitId]);
        conv = { ...conv, booking_id: match.bookingId, unit_id: match.unitId, verification_level: "matched" };
        await writeAudit(tx, BOT_AUDIT(input.orgId), "inbox.booking_matched", "conversation", conv.id, { bookingId: match.bookingId, method: "ref+name+date" });
      }
    }
    return { duplicate: false as const, conv, messageId: msg.rows[0].id };
  });

  if (stored.duplicate) return { status: "duplicate", conversationId: stored.conv.id, messageId: null, bot: null };
  let bot: BotOutcome | null = null;
  try {
    bot = await runGuestBot(stored.conv.org_id, stored.conv.id, stored.messageId, text, deps);
  } catch (error) {
    // Tin đã lưu bền; bot lỗi (ví dụ tra cứu Q&A hỏng) thì người xử lý thủ công. Không log nội dung tin.
    console.error("[inbox] bot lỗi với tin", stored.messageId, (error as Error)?.message);
  }
  return { status: "stored", conversationId: stored.conv.id, messageId: stored.messageId, bot };
}

// ───────────────────────── Bot nháp (không LLM) ─────────────────────────

const HANDOFF_REASON_LABELS: Record<string, string> = {
  access_code: "Khách hỏi mã cửa / vào nhà",
  refund: "Khách hỏi hoàn tiền",
  incident: "Khách báo sự cố",
  emergency: "Khách báo tình huống khẩn cấp",
  human_requested: "Khách xin gặp người thật",
  no_grounded_answer: "Không có câu trả lời đã duyệt",
  handoff_entry: "Q&A yêu cầu chuyển người",
  needs_verification: "Cần khớp booking trước khi trả lời",
  access_like_answer: "Câu trả lời có dáng chứa mã truy cập",
  manual: "Nhân viên yêu cầu chuyển người",
};

export function handoffReasonLabel(reason: string) {
  return HANDOFF_REASON_LABELS[reason] ?? reason;
}

export async function runGuestBot(orgId: string, conversationId: string, inboundMessageId: string, text: string | null, deps?: Partial<InboxDeps>): Promise<BotOutcome> {
  const conv = await queryOne<ConvRow & { property_id: string | null }>(
    `SELECT ${CONV_COLS.split(", ").map((c) => `c.${c}`).join(", ")}, u.property_id
       FROM conversations c LEFT JOIN units u ON u.id = c.unit_id AND u.org_id = c.org_id
      WHERE c.id = $1 AND c.org_id = $2`,
    [conversationId, orgId],
  );
  if (!conv || conv.kind !== "guest") return { action: "skipped", reason: "not_guest" };
  if (conv.handled_by !== "bot") return { action: "skipped", reason: "human_handling" };
  if (!text?.trim()) return { action: "skipped", reason: "no_text" };

  const intent = detectSensitiveIntent(text);
  let answer: GroundedAnswer | null = null;
  let handoff: { reason: string; category: TicketCategory; priority: TicketPriority } | null = intent
    ? { reason: intent.reason, category: intent.category, priority: intent.priority }
    : null;

  if (!handoff) {
    const d = await resolveDeps(deps);
    answer = await d.findAnswer({
      orgId,
      text,
      unitId: conv.unit_id,
      propertyId: conv.property_id,
      verification: conv.verification_level,
      language: detectLanguage(text),
      opsDate: todayOps(),
    });
    if (!answer) handoff = { reason: "no_grounded_answer", category: "question", priority: "P2" };
    else if (answer.sensitivity === "handoff") handoff = { reason: "handoff_entry", category: "question", priority: "P2" };
    else if (answer.sensitivity === "restricted" && conv.verification_level === "none") handoff = { reason: "needs_verification", category: "question", priority: "P2" };
    else if (looksLikeAccessSecret(answer.answer)) handoff = { reason: "access_like_answer", category: "access", priority: "P1" };
  }

  const outcome = await withTx(async (tx): Promise<BotOutcome> => {
    const locked = await lockConversation(tx, orgId, conversationId);
    // Có thể người đã tiếp quản trong lúc tra cứu — bot im lặng.
    if (locked.handled_by !== "bot") return { action: "skipped", reason: "human_handling" };
    if (handoff) {
      const res = await createHandoffTx(tx, {
        conv: locked,
        reason: handoff.reason,
        category: handoff.category,
        priority: handoff.priority,
        summary: `${HANDOFF_REASON_LABELS[handoff.reason] ?? handoff.reason}`,
        stepsTried: intent ? ["Nhận diện yêu cầu nhạy cảm — bot không trả lời"] : ["Tra kho Q&A đã duyệt"],
        audit: BOT_AUDIT(orgId),
        createdByType: "bot",
        createdBy: null,
        targetUserId: null,
        sourceMessageId: inboundMessageId,
      });
      return { action: "handoff", handoffId: res.handoffId, ticketId: res.ticketId, reason: handoff.reason, created: res.created };
    }
    const a = answer!;
    const paused = await isPaused(orgId, [{ scope: "agent", key: "guest" }, { scope: "channel", key: "whatsapp_guest" }], { client: tx });
    const autoSend = !paused.paused;
    const grounding = { entryId: a.entryId, entryKey: a.entryKey, version: a.version, scope: a.scope, topic: a.topic, language: a.language, sensitivity: a.sensitivity, score: a.score, inReplyTo: inboundMessageId };
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status, grounding)
       VALUES ($1,$2,'out','bot','Bot Q&A',$3,$4,$5) RETURNING id`,
      [orgId, conversationId, a.answer, autoSend ? "queued" : "draft", JSON.stringify(grounding)],
    );
    await writeAudit(tx, BOT_AUDIT(orgId), autoSend ? "inbox.bot_queued" : "inbox.bot_draft", "message", rows[0].id, { conversationId, entryId: a.entryId, version: a.version });
    return autoSend ? { action: "queued", messageId: rows[0].id, autoSend: true } : { action: "draft", messageId: rows[0].id, autoSend: false, pausedReason: paused.reason };
  });

  // Tin bot 'queued' do worker gửi (jobs.ts) — webhook trả lời ngay.
  return outcome;
}

// ───────────────────────── Handoff & người nhận ─────────────────────────

const PURPOSE_OF: Partial<Record<TicketCategory, string>> = { maintenance: "maintenance", cleaning: "cleaning", booking_change: "booking", payment_refund: "finance" };

/** Người trực theo mục đích (cấp thấp nhất đang bật); chưa khai thì điều phối Budapest, rồi Leader/phụ trách chính. */
export async function onDutyRecipients(tx: Queryable, orgId: string, category: TicketCategory): Promise<string[]> {
  for (const purpose of [PURPOSE_OF[category], "guest_support"].filter(Boolean) as string[]) {
    const { rows } = await tx.query<{ user_id: string }>(
      `SELECT ec.user_id FROM escalation_contacts ec JOIN users u ON u.id = ec.user_id AND u.org_id = ec.org_id AND u.active
        WHERE ec.org_id = $1 AND ec.purpose = $2 AND ec.active
          AND ec.level = (SELECT min(level) FROM escalation_contacts WHERE org_id = $1 AND purpose = $2 AND active)`,
      [orgId, purpose],
    );
    if (rows.length) return rows.map((r) => r.user_id);
  }
  for (const roles of [["bp_coordinator"], ["leader", "vn_manager"]]) {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM users WHERE org_id = $1 AND active AND role = ANY($2::text[]) ORDER BY created_at", [orgId, roles]);
    if (rows.length) return rows.map((r) => r.id);
  }
  return [];
}

interface HandoffTxInput {
  conv: ConvRow;
  reason: string;
  category: TicketCategory;
  priority: TicketPriority;
  summary: string;
  stepsTried: string[];
  audit: AuditActor;
  createdByType: "user" | "bot" | "system";
  createdBy: string | null;
  targetUserId: string | null;
  sourceMessageId: string | null;
}

async function createHandoffTx(tx: pg.PoolClient, h: HandoffTxInput): Promise<{ handoffId: string; ticketId: string | null; created: boolean }> {
  const orgId = h.conv.org_id;
  // Đã có yêu cầu chuyển người đang chờ ⇒ không tạo thêm, không báo lại.
  const open = await tx.query<{ id: string; ticket_id: string | null }>(
    "SELECT id, ticket_id FROM handoffs WHERE conversation_id = $1 AND org_id = $2 AND status IN ('requested','escalated') ORDER BY created_at LIMIT 1",
    [h.conv.id, orgId],
  );
  if (open.rows[0]) return { handoffId: open.rows[0].id, ticketId: open.rows[0].ticket_id, created: false };

  const ctx = await tx.query<{ booking_ref: string | null; unit_code: string | null }>(
    `SELECT (SELECT external_ref FROM bookings WHERE id = $1 AND org_id = $3) AS booking_ref,
            (SELECT code FROM units WHERE id = $2 AND org_id = $3) AS unit_code`,
    [h.conv.booking_id, h.conv.unit_id, orgId],
  );
  const due = acceptDueAt(h.priority, now());
  const ticket = await tx.query<{ id: string; version: number }>(
    `INSERT INTO tickets (org_id, conversation_id, booking_id, unit_id, category, priority, status, summary, assignee_user_id, accept_due_at, created_by_type, created_by, is_demo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, version`,
    [orgId, h.conv.id, h.conv.booking_id, h.conv.unit_id, h.category, h.priority, h.targetUserId ? "assigned" : "new", h.summary.slice(0, 300), h.targetUserId, due, h.createdByType, h.createdBy, h.conv.is_demo],
  );
  const context = {
    bookingRef: ctx.rows[0]?.booking_ref ?? null,
    unitCode: ctx.rows[0]?.unit_code ?? null,
    verification: h.conv.verification_level,
    category: h.category,
    priority: h.priority,
    language: h.conv.language,
    stepsTried: h.stepsTried,
    sourceMessageId: h.sourceMessageId,
  };
  const handoff = await tx.query<{ id: string }>(
    `INSERT INTO handoffs (org_id, conversation_id, ticket_id, reason, context, target_user_id, status, accept_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,'requested',$7) RETURNING id`,
    [orgId, h.conv.id, ticket.rows[0].id, h.reason, JSON.stringify(context), h.targetUserId, due],
  );
  await tx.query("UPDATE conversations SET status = 'open', updated_at = now() WHERE id = $1", [h.conv.id]);

  const recipients = h.targetUserId ? [h.targetUserId] : await onDutyRecipients(tx, orgId, h.category);
  for (const userId of recipients) {
    await enqueueStaffNotification(tx, {
      orgId,
      recipientUserId: userId,
      templateKey: "inbox.handoff_requested",
      payload: { conversationId: h.conv.id, handoffId: handoff.rows[0].id, ticketId: ticket.rows[0].id, reason: h.reason, ...context, acceptDueAt: due.toISOString() },
      dedupeKey: `handoff:${handoff.rows[0].id}:requested:${userId}`,
    });
  }
  await writeAudit(tx, h.audit, "inbox.handoff_requested", "handoff", handoff.rows[0].id, {
    conversationId: h.conv.id,
    ticketId: ticket.rows[0].id,
    reason: h.reason,
    priority: h.priority,
    notified: recipients.length,
  });
  return { handoffId: handoff.rows[0].id, ticketId: ticket.rows[0].id, created: true };
}

const requestHandoffInput = z.object({
  reason: z.string().trim().min(3, "Cần lý do chuyển người (ít nhất 3 ký tự).").max(500),
  targetUserId: z.string().uuid().optional().nullable(),
  category: z.enum(TICKET_CATEGORIES as [TicketCategory, ...TicketCategory[]]).optional(),
  priority: z.enum(TICKET_PRIORITIES as [TicketPriority, ...TicketPriority[]]).optional(),
});

export async function requestHandoff(actor: Actor, conversationId: string, raw: unknown) {
  assertCan(actor, "inbox.reply");
  const input = requestHandoffInput.parse(raw);
  return withTx(async (tx) => {
    const conv = await lockConversation(tx, actor.orgId, conversationId);
    if (input.targetUserId) await assertOrgUser(tx, actor.orgId, input.targetUserId);
    const res = await createHandoffTx(tx, {
      conv,
      reason: "manual",
      category: input.category ?? "question",
      priority: input.priority ?? "P2",
      summary: input.reason,
      stepsTried: [`${actor.fullName}: ${input.reason}`],
      audit: auditActorOf(actor),
      createdByType: "user",
      createdBy: actor.userId,
      targetUserId: input.targetUserId ?? null,
      sourceMessageId: null,
    });
    if (!res.created) throw conflict("handoff_open", "Hội thoại đã có yêu cầu chuyển người đang chờ nhận.");
    return res;
  });
}

async function assertOrgUser(tx: Queryable, orgId: string, userId: string) {
  const { rows } = await tx.query("SELECT 1 FROM users WHERE id = $1 AND org_id = $2 AND active", [userId, orgId]);
  if (!rows[0]) throw notFound("người nhận");
}

/** Người nhận bấm nhận: lúc này mới ghi "đã kết nối" (accepted), hội thoại chuyển sang người, bot im lặng. */
export async function acceptHandoff(actor: Actor, handoffId: string) {
  assertCan(actor, "inbox.takeover");
  if (!isUuid(handoffId)) throw notFound("yêu cầu chuyển người");
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; conversation_id: string; ticket_id: string | null; status: string }>(
      "SELECT id, conversation_id, ticket_id, status FROM handoffs WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [handoffId, actor.orgId],
    );
    const h = rows[0];
    if (!h) throw notFound("yêu cầu chuyển người");
    if (h.status !== "requested" && h.status !== "escalated") throw conflict("handoff_not_open", "Yêu cầu này đã được nhận hoặc đã huỷ.");
    await lockConversation(tx, actor.orgId, h.conversation_id);
    await tx.query("UPDATE handoffs SET status = 'accepted', accepted_by = $2, accepted_at = now() WHERE id = $1", [h.id, actor.userId]);
    await tx.query(
      "UPDATE conversations SET handled_by = 'human', takeover_by = $2, takeover_at = now(), assignee_user_id = $2, updated_at = now() WHERE id = $1 AND org_id = $3",
      [h.conversation_id, actor.userId, actor.orgId],
    );
    if (h.ticket_id) {
      await tx.query(
        `UPDATE tickets SET status = 'accepted', assignee_user_id = $2, accepted_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 AND org_id = $3 AND status IN ('new','assigned')`,
        [h.ticket_id, actor.userId, actor.orgId],
      );
    }
    await writeAudit(tx, auditActorOf(actor), "inbox.handoff_accepted", "handoff", h.id, { conversationId: h.conversation_id, ticketId: h.ticket_id });
    return { ok: true, conversationId: h.conversation_id };
  });
}

const reasonInput = z.object({ reason: z.string().trim().min(3, "Cần lý do (ít nhất 3 ký tự).").max(500) });

export async function cancelHandoff(actor: Actor, handoffId: string, raw: unknown) {
  assertCan(actor, "inbox.takeover");
  if (!isUuid(handoffId)) throw notFound("yêu cầu chuyển người");
  const input = reasonInput.parse(raw);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string; conversation_id: string }>(
      "SELECT id, status, conversation_id FROM handoffs WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [handoffId, actor.orgId],
    );
    if (!rows[0]) throw notFound("yêu cầu chuyển người");
    if (rows[0].status !== "requested" && rows[0].status !== "escalated") throw conflict("handoff_not_open", "Yêu cầu này đã được nhận hoặc đã huỷ.");
    await tx.query("UPDATE handoffs SET status = 'cancelled' WHERE id = $1", [handoffId]);
    await writeAudit(tx, auditActorOf(actor), "inbox.handoff_cancelled", "handoff", handoffId, { conversationId: rows[0].conversation_id, reason: input.reason });
    return { ok: true };
  });
}

// ───────────────────────── Tiếp quản / trả bot / đã đọc ─────────────────────────

export async function takeOverConversation(actor: Actor, conversationId: string) {
  assertCan(actor, "inbox.takeover");
  return withTx(async (tx) => {
    const conv = await lockConversation(tx, actor.orgId, conversationId);
    if (conv.handled_by === "human" && conv.takeover_by === actor.userId) throw conflict("no_change", "Bạn đang tiếp quản hội thoại này.");
    await tx.query(
      "UPDATE conversations SET handled_by = 'human', takeover_by = $2, takeover_at = now(), assignee_user_id = $2, updated_at = now() WHERE id = $1",
      [conv.id, actor.userId],
    );
    await writeAudit(tx, auditActorOf(actor), "inbox.takeover", "conversation", conv.id, { previous: conv.handled_by, previousTakeoverBy: conv.takeover_by });
    return { ok: true, handledBy: "human" };
  });
}

export async function releaseToBot(actor: Actor, conversationId: string) {
  assertCan(actor, "inbox.takeover");
  return withTx(async (tx) => {
    const conv = await lockConversation(tx, actor.orgId, conversationId);
    if (conv.kind !== "guest") throw new AppError("not_guest", "Chỉ hội thoại với khách mới trả cho bot. Hội thoại nội bộ/nhóm luôn do người xử lý.", 422);
    if (conv.handled_by === "bot") throw conflict("no_change", "Bot đang xử lý hội thoại này.");
    await tx.query("UPDATE conversations SET handled_by = 'bot', takeover_by = NULL, takeover_at = NULL, updated_at = now() WHERE id = $1", [conv.id]);
    await writeAudit(tx, auditActorOf(actor), "inbox.release_to_bot", "conversation", conv.id, { previousTakeoverBy: conv.takeover_by });
    return { ok: true, handledBy: "bot" };
  });
}

export async function markConversationRead(actor: Actor, conversationId: string) {
  assertCan(actor, "inbox.view");
  if (!isUuid(conversationId)) throw notFound("hội thoại");
  const row = await queryOne<{ id: string }>("UPDATE conversations SET unread_count = 0 WHERE id = $1 AND org_id = $2 RETURNING id", [conversationId, actor.orgId]);
  if (!row) throw notFound("hội thoại");
  return { ok: true };
}

// ───────────────────────── Trả lời / duyệt nháp / gửi ─────────────────────────

const replyInput = z.object({ body: z.string().trim().min(1, "Nội dung trống.").max(4000, "Nội dung quá dài (tối đa 4000 ký tự).") });

/**
 * Web KHÔNG gửi: chỉ ghi 'queued'. Duy nhất worker (`jobs.ts` → runSendQueue) gửi ra kênh, tuần tự, hạn mức theo DB.
 * Kết quả thật (sent/failed + lý do) ghi vào tin; màn hình đọc lại.
 */
export interface QueuedResult {
  messageId: string;
  status: "queued";
}

/** Nhân viên trả lời: ghi tin 'queued'; worker gửi. */
export async function replyToConversation(actor: Actor, conversationId: string, raw: unknown): Promise<QueuedResult> {
  assertCan(actor, "inbox.reply");
  const input = replyInput.parse(raw);
  return withTx(async (tx) => {
    const conv = await lockConversation(tx, actor.orgId, conversationId);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO messages (org_id, conversation_id, direction, author_type, author_user_id, author_name, body, status, approved_by)
       VALUES ($1,$2,'out','staff',$3,$4,$5,'queued',$3) RETURNING id`,
      [actor.orgId, conv.id, actor.userId, actor.fullName, input.body],
    );
    await tx.query("UPDATE conversations SET last_message_at = now(), unread_count = 0, updated_at = now() WHERE id = $1", [conv.id]);
    await writeAudit(tx, auditActorOf(actor), "inbox.reply", "message", rows[0].id, { conversationId: conv.id, length: input.body.length });
    return { messageId: rows[0].id, status: "queued" as const };
  });
}

const approveInput = z.object({ body: z.string().trim().min(1, "Nội dung trống.").max(4000).optional().nullable() });

/** Duyệt nháp bot (có thể sửa). Sửa nội dung thì căn cứ vẫn giữ nhưng đánh dấu đã sửa. */
export async function approveDraft(actor: Actor, messageId: string, raw: unknown): Promise<QueuedResult> {
  assertCan(actor, "inbox.reply");
  if (!isUuid(messageId)) throw notFound("tin nháp");
  const input = approveInput.parse(raw ?? {});
  await withTx(async (tx) => {
    const msg = await lockDraft(tx, actor.orgId, messageId);
    const edited = input.body != null && input.body !== msg.body;
    const grounding = msg.grounding ? { ...msg.grounding, editedByStaff: edited || undefined } : null;
    await tx.query("UPDATE messages SET status = 'queued', body = $2, approved_by = $3, grounding = $4, error = NULL WHERE id = $1", [
      messageId,
      edited ? input.body : msg.body,
      actor.userId,
      grounding ? JSON.stringify(grounding) : null,
    ]);
    await tx.query("UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1", [msg.conversation_id]);
    await writeAudit(tx, auditActorOf(actor), "inbox.draft_approved", "message", messageId, { conversationId: msg.conversation_id, edited, entryId: msg.grounding?.entryId ?? null });
  });
  return { messageId, status: "queued" };
}

export async function discardDraft(actor: Actor, messageId: string) {
  assertCan(actor, "inbox.reply");
  if (!isUuid(messageId)) throw notFound("tin nháp");
  return withTx(async (tx) => {
    const msg = await lockDraft(tx, actor.orgId, messageId);
    await tx.query("UPDATE messages SET status = 'discarded' WHERE id = $1", [messageId]);
    await writeAudit(tx, auditActorOf(actor), "inbox.draft_discarded", "message", messageId, { conversationId: msg.conversation_id });
    return { ok: true };
  });
}

async function lockDraft(tx: Queryable, orgId: string, messageId: string) {
  const { rows } = await tx.query<{ id: string; conversation_id: string; status: string; body: string | null; grounding: Record<string, unknown> | null }>(
    "SELECT id, conversation_id, status, body, grounding FROM messages WHERE id = $1 AND org_id = $2 AND direction = 'out' FOR UPDATE",
    [messageId, orgId],
  );
  const msg = rows[0];
  if (!msg) throw notFound("tin nháp");
  if (msg.status !== "draft" && msg.status !== "pending_approval") throw conflict("not_draft", "Tin này không còn là nháp (đã gửi, đã huỷ hoặc người khác vừa duyệt).");
  return msg;
}

/**
 * Gửi lại tin thất bại (ví dụ sau khi đã cấu hình Evolution). Tin "không rõ đã gửi hay chưa" chỉ người bấm gửi lại
 * (sau khi kiểm trên điện thoại) — worker không bao giờ tự gửi lại.
 */
export async function retryMessage(actor: Actor, messageId: string): Promise<QueuedResult> {
  assertCan(actor, "inbox.reply");
  if (!isUuid(messageId)) throw notFound("tin");
  await withTx(async (tx) => {
    const { rows } = await tx.query<{ status: string; conversation_id: string; error: string | null }>(
      "SELECT status, conversation_id, error FROM messages WHERE id = $1 AND org_id = $2 AND direction = 'out' FOR UPDATE",
      [messageId, actor.orgId],
    );
    if (!rows[0]) throw notFound("tin");
    if (rows[0].status !== "failed") throw conflict("not_failed", "Chỉ gửi lại được tin đang ở trạng thái thất bại.");
    await tx.query("UPDATE messages SET status = 'queued', error = NULL, locked_at = NULL WHERE id = $1", [messageId]);
    await writeAudit(tx, auditActorOf(actor), "inbox.retry", "message", messageId, { conversationId: rows[0].conversation_id, previousError: rows[0].error });
  });
  return { messageId, status: "queued" };
}


// ───────────────────────── Gắn booking thủ công ─────────────────────────

const attachInput = z.object({ bookingId: z.string().uuid("Mã booking không hợp lệ.").nullable() });

export async function attachBooking(actor: Actor, conversationId: string, raw: unknown) {
  assertCan(actor, "inbox.reply");
  assertCan(actor, "booking.view", "Cần quyền xem booking để gắn booking vào hội thoại.");
  const input = attachInput.parse(raw);
  return withTx(async (tx) => {
    const conv = await lockConversation(tx, actor.orgId, conversationId);
    if (input.bookingId === null) {
      if (!conv.booking_id) throw conflict("no_change", "Hội thoại chưa gắn booking.");
      await tx.query("UPDATE conversations SET booking_id = NULL, unit_id = NULL, verification_level = 'none', updated_at = now() WHERE id = $1", [conv.id]);
      await writeAudit(tx, auditActorOf(actor), "inbox.booking_detached", "conversation", conv.id, { previousBookingId: conv.booking_id });
      return { ok: true, bookingId: null };
    }
    const b = await tx.query<{ id: string }>("SELECT id FROM bookings WHERE id = $1 AND org_id = $2", [input.bookingId, actor.orgId]);
    if (!b.rows[0]) throw notFound("booking");
    const units = await tx.query<{ unit_id: string }>("SELECT DISTINCT unit_id FROM booking_allocations WHERE booking_id = $1 AND org_id = $2 AND status = 'active'", [input.bookingId, actor.orgId]);
    const unitId = units.rows.length === 1 ? units.rows[0].unit_id : null;
    await tx.query("UPDATE conversations SET booking_id = $2, unit_id = $3, verification_level = 'matched', updated_at = now() WHERE id = $1", [conv.id, input.bookingId, unitId]);
    await writeAudit(tx, auditActorOf(actor), "inbox.booking_attached", "conversation", conv.id, { bookingId: input.bookingId, previousBookingId: conv.booking_id, method: "manual" });
    return { ok: true, bookingId: input.bookingId };
  });
}

// ───────────────────────── Ticket ─────────────────────────

const createTicketInput = z.object({
  conversationId: z.string().uuid().optional().nullable(),
  category: z.enum(TICKET_CATEGORIES as [TicketCategory, ...TicketCategory[]]),
  priority: z.enum(TICKET_PRIORITIES as [TicketPriority, ...TicketPriority[]]).default("P2"),
  summary: z.string().trim().min(3, "Cần tóm tắt (ít nhất 3 ký tự).").max(300),
  detail: z.string().trim().max(4000).optional().nullable(),
  assigneeUserId: z.string().uuid().optional().nullable(),
});

type TicketNotice = { id: string; version: number; conversation_id: string | null; category: string; priority: string; summary: string; accept_due_at: Date | null };

async function notifyTicket(tx: Queryable, orgId: string, t: TicketNotice, kind: "created" | "assigned", recipients: string[]) {
  for (const userId of recipients) {
    await enqueueStaffNotification(tx, {
      orgId,
      recipientUserId: userId,
      templateKey: kind === "created" ? "inbox.ticket_created" : "inbox.ticket_assigned",
      payload: { ticketId: t.id, conversationId: t.conversation_id, category: t.category, priority: t.priority, summary: t.summary, acceptDueAt: t.accept_due_at?.toISOString() ?? null },
      dedupeKey: kind === "created" ? `ticket:${t.id}:created:${userId}` : `ticket:${t.id}:assigned:${userId}:v${t.version}`,
    });
  }
}

const TICKET_RETURN = "id, version, conversation_id, category, priority, summary, status, assignee_user_id, accept_due_at";

export async function createTicket(actor: Actor, raw: unknown) {
  assertCan(actor, "tickets.manage");
  const input = createTicketInput.parse(raw);
  return withTx(async (tx) => {
    let conv: ConvRow | null = null;
    if (input.conversationId) conv = await lockConversation(tx, actor.orgId, input.conversationId);
    if (input.assigneeUserId) await assertOrgUser(tx, actor.orgId, input.assigneeUserId);
    const { rows } = await tx.query<TicketNotice>(
      `INSERT INTO tickets (org_id, conversation_id, booking_id, unit_id, category, priority, status, summary, detail, assignee_user_id, accept_due_at, created_by_type, created_by, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'user',$12,$13) RETURNING ${TICKET_RETURN}`,
      [
        actor.orgId,
        conv?.id ?? null,
        conv?.booking_id ?? null,
        conv?.unit_id ?? null,
        input.category,
        input.priority,
        input.assigneeUserId ? "assigned" : "new",
        input.summary,
        input.detail ?? null,
        input.assigneeUserId ?? null,
        acceptDueAt(input.priority, now()),
        actor.userId,
        conv?.is_demo ?? false,
      ],
    );
    const t = rows[0];
    const recipients = input.assigneeUserId ? [input.assigneeUserId] : await onDutyRecipients(tx, actor.orgId, input.category);
    await notifyTicket(tx, actor.orgId, t, input.assigneeUserId ? "assigned" : "created", recipients.filter((u) => u !== actor.userId));
    await writeAudit(tx, auditActorOf(actor), "ticket.create", "ticket", t.id, { conversationId: t.conversation_id, category: t.category, priority: t.priority, assignee: input.assigneeUserId ?? null });
    return t;
  });
}

interface TicketRow {
  id: string;
  version: number;
  status: string;
  priority: TicketPriority;
  assignee_user_id: string | null;
  conversation_id: string | null;
  category: string;
  summary: string;
}

async function lockTicket(tx: Queryable, orgId: string, ticketId: string, expectedVersion: number): Promise<TicketRow> {
  if (!isUuid(ticketId)) throw notFound("ticket");
  const { rows } = await tx.query<TicketRow>(
    "SELECT id, version, status, priority, assignee_user_id, conversation_id, category, summary FROM tickets WHERE id = $1 AND org_id = $2 FOR UPDATE",
    [ticketId, orgId],
  );
  if (!rows[0]) throw notFound("ticket");
  if (rows[0].version !== expectedVersion) throw conflict("version_conflict", "Ticket vừa được người khác cập nhật. Tải lại rồi thử lại.", { currentVersion: rows[0].version });
  return rows[0];
}

const CLOSED_TICKET = ["resolved", "verified", "closed"];

const assignInput = z.object({ assigneeUserId: z.string().uuid("Chọn người nhận."), expectedVersion: z.number().int().positive() });

export async function assignTicket(actor: Actor, ticketId: string, raw: unknown) {
  assertCan(actor, "tickets.manage");
  const input = assignInput.parse(raw);
  return withTx(async (tx) => {
    const t = await lockTicket(tx, actor.orgId, ticketId, input.expectedVersion);
    if (CLOSED_TICKET.includes(t.status)) throw conflict("ticket_closed", "Ticket đã xử lý xong — không giao lại.");
    await assertOrgUser(tx, actor.orgId, input.assigneeUserId);
    const due = acceptDueAt(t.priority, now());
    const { rows } = await tx.query<TicketNotice>(
      `UPDATE tickets SET assignee_user_id = $2, status = 'assigned', accepted_at = NULL, accept_due_at = $3, version = version + 1, updated_at = now()
        WHERE id = $1 RETURNING ${TICKET_RETURN}`,
      [t.id, input.assigneeUserId, due],
    );
    if (input.assigneeUserId !== actor.userId) await notifyTicket(tx, actor.orgId, rows[0], "assigned", [input.assigneeUserId]);
    await writeAudit(tx, auditActorOf(actor), "ticket.assign", "ticket", t.id, { from: t.assignee_user_id, to: input.assigneeUserId });
    return rows[0];
  });
}

const versionInput = z.object({ expectedVersion: z.number().int().positive() });

export async function acceptTicket(actor: Actor, ticketId: string, raw: unknown) {
  assertCan(actor, "tickets.manage");
  const input = versionInput.parse(raw);
  return withTx(async (tx) => {
    const t = await lockTicket(tx, actor.orgId, ticketId, input.expectedVersion);
    if (t.status !== "new" && t.status !== "assigned") throw conflict("ticket_not_open", "Ticket đã được nhận hoặc đang xử lý.");
    if (t.assignee_user_id && t.assignee_user_id !== actor.userId) throw forbidden("Ticket đã giao cho người khác — chỉ người được giao mới bấm nhận (hoặc giao lại cho mình trước).");
    const { rows } = await tx.query(
      `UPDATE tickets SET status = 'accepted', assignee_user_id = $2, accepted_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${TICKET_RETURN}`,
      [t.id, actor.userId],
    );
    await writeAudit(tx, auditActorOf(actor), "ticket.accept", "ticket", t.id, {});
    return rows[0];
  });
}

const statusInput = z.object({
  status: z.enum(["in_progress", "awaiting_guest", "awaiting_vendor", "resolved", "verified", "closed"]),
  expectedVersion: z.number().int().positive(),
  note: z.string().trim().max(1000).optional().nullable(),
});

export async function setTicketStatus(actor: Actor, ticketId: string, raw: unknown) {
  assertCan(actor, "tickets.manage");
  const input = statusInput.parse(raw);
  return withTx(async (tx) => {
    const t = await lockTicket(tx, actor.orgId, ticketId, input.expectedVersion);
    if (!(TICKET_TRANSITIONS[t.status] ?? []).includes(input.status)) {
      throw conflict("invalid_transition", `Không chuyển được từ "${t.status}" sang "${input.status}".`);
    }
    // Đóng khi chưa ai nhận (trùng/nhầm) hoặc mở lại ⇒ bắt buộc ghi chú.
    if ((input.status === "closed" && (t.status === "new" || t.status === "assigned")) || (t.status === "resolved" && input.status === "in_progress")) {
      if ((input.note ?? "").length < 3) throw invalid("Cần ghi chú lý do (ít nhất 3 ký tự).");
    }
    const { rows } = await tx.query(
      `UPDATE tickets SET status = $2::text, resolved_at = CASE WHEN $2::text = 'resolved' THEN now() WHEN $2::text = 'in_progress' THEN NULL ELSE resolved_at END,
              version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${TICKET_RETURN}`,
      [t.id, input.status],
    );
    await writeAudit(tx, auditActorOf(actor), "ticket.status", "ticket", t.id, { from: t.status, to: input.status, note: input.note ?? null });
    return rows[0];
  });
}

export function canManageInbox(actor: Actor) {
  return { reply: can(actor, "inbox.reply"), takeover: can(actor, "inbox.takeover"), tickets: can(actor, "tickets.manage"), attachBooking: can(actor, "inbox.reply") && can(actor, "booking.view") };
}
