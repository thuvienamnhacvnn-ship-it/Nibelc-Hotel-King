import { z } from "zod";
import { withTx } from "@/lib/db";
import { AppError, conflict, forbidden, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/http";
import { type Actor, assertCan, can } from "@/modules/auth/actor";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";
import { AGENT_KEYS, CHANNEL_KEYS } from "@/modules/automation/switches";
import { ESCALATION_PURPOSES } from "./escalation";
import { buildDailyReport } from "./report";

/** Thao tác ghi của Agent Manager / Agent Center. Quyền kiểm ở đây (server), mọi thay đổi có audit. */

const reason = z.string().trim().min(3, "Cần lý do (ít nhất 3 ký tự).").max(500);

// ───────────── Báo cáo ─────────────

const reportInput = z.object({
  opsDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải dạng YYYY-MM-DD."),
  kind: z.enum(["morning", "evening"]),
});

export async function generateReport(actor: Actor, raw: unknown) {
  assertCan(actor, "reports.view");
  const input = reportInput.parse(raw);
  const result = await buildDailyReport(actor.orgId, input.kind, input.opsDate, { generatedBy: actor.userId });
  await writeAudit(null, auditActorOf(actor), "report.generate", "manager_report", result.id, { opsDate: input.opsDate, kind: input.kind, sourcesFailed: result.data.sourcesFailed.length });
  return { id: result.id, cutoffAt: result.data.cutoffAt };
}

// ───────────── Công tắc tự động ─────────────

const switchInput = z
  .object({
    scope: z.enum(["org", "agent", "channel"]),
    key: z.string().default(""),
    paused: z.boolean(),
    reason,
  })
  .superRefine((v, ctx) => {
    const ok = v.scope === "org" ? v.key === "" : v.scope === "agent" ? (AGENT_KEYS as readonly string[]).includes(v.key) : (CHANNEL_KEYS as readonly string[]).includes(v.key);
    if (!ok) ctx.addIssue({ code: "custom", message: "Công tắc không hợp lệ.", path: ["key"] });
  });

export async function setAutomationSwitch(actor: Actor, raw: unknown) {
  assertCan(actor, "automation.pause");
  const input = switchInput.parse(raw);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ paused: boolean }>("SELECT paused FROM automation_switches WHERE org_id = $1 AND scope = $2 AND scope_key = $3 FOR UPDATE", [
      actor.orgId,
      input.scope,
      input.key,
    ]);
    const before = rows[0] ? rows[0].paused : null;
    await tx.query(
      `INSERT INTO automation_switches (org_id, scope, scope_key, paused, reason, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (org_id, scope, scope_key) DO UPDATE SET paused = EXCLUDED.paused, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [actor.orgId, input.scope, input.key, input.paused, input.reason, actor.userId],
    );
    await writeAudit(tx, auditActorOf(actor), input.paused ? "automation.pause" : "automation.resume", "automation_switch", `${input.scope}:${input.key}`, {
      before: before === null ? "chưa có (mặc định dừng)" : before ? "dừng" : "chạy",
      after: input.paused ? "dừng" : "chạy",
      reason: input.reason,
    });
    return { ok: true, paused: input.paused };
  });
}

// ───────────── Outbox ─────────────

export function canRetryOutbox(actor: Actor) {
  return actor.role === "admin" || actor.role === "leader";
}

/** Thử lại sự kiện nền hỏng/đang chờ: đặt lại pending, giữ nguyên số lần đã thử (lần thử kế tiếp lỗi sẽ lại thành dead). */
export async function retryOutboxEvent(actor: Actor, eventId: string) {
  if (!canRetryOutbox(actor)) throw forbidden("Chỉ quản trị hoặc Leader được thử lại sự kiện nền.");
  if (!isUuid(eventId)) throw notFound("sự kiện");
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string; topic: string; attempts: number }>(
      "SELECT id, status, topic, attempts FROM outbox_events WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [eventId, actor.orgId],
    );
    const ev = rows[0];
    if (!ev) throw notFound("sự kiện");
    if (ev.status !== "dead" && ev.status !== "pending") throw conflict("not_retryable", "Chỉ thử lại được sự kiện hỏng hoặc đang chờ.");
    await tx.query("UPDATE outbox_events SET status = 'pending', available_at = now(), locked_until = NULL, locked_by = NULL WHERE id = $1 AND org_id = $2", [eventId, actor.orgId]);
    await writeAudit(tx, auditActorOf(actor), "outbox.retry", "outbox_event", eventId, { topic: ev.topic, from: ev.status, attempts: ev.attempts });
    return { ok: true };
  });
}

// ───────────── Người trực ─────────────

const contactInput = z.object({
  purpose: z.enum(ESCALATION_PURPOSES),
  level: z.number().int().min(0).max(9),
  userId: z.string().uuid("Chọn người trực."),
});

export async function addEscalationContact(actor: Actor, raw: unknown) {
  assertCan(actor, "automation.pause");
  const input = contactInput.parse(raw);
  return withTx(async (tx) => {
    const { rows: users } = await tx.query<{ id: string; full_name: string; role: string }>("SELECT id, full_name, role FROM users WHERE id = $1 AND org_id = $2 AND active", [
      input.userId,
      actor.orgId,
    ]);
    if (!users[0]) throw notFound("người dùng");
    if (users[0].role === "cleaner") throw new AppError("invalid_input", "Cleaner không nhận cảnh báo đẩy lên.", 422);
    const { rows: dup } = await tx.query("SELECT id FROM escalation_contacts WHERE org_id = $1 AND purpose = $2 AND level = $3 AND user_id = $4", [
      actor.orgId,
      input.purpose,
      input.level,
      input.userId,
    ]);
    if (dup[0]) throw conflict("duplicate", "Người này đã có ở cấp này.");
    const { rows } = await tx.query<{ id: string }>("INSERT INTO escalation_contacts (org_id, purpose, level, user_id) VALUES ($1,$2,$3,$4) RETURNING id", [
      actor.orgId,
      input.purpose,
      input.level,
      input.userId,
    ]);
    await writeAudit(tx, auditActorOf(actor), "escalation_contact.add", "escalation_contact", rows[0].id, { purpose: input.purpose, level: input.level, user: users[0].full_name });
    return { id: rows[0].id };
  });
}

const contactPatch = z.object({ level: z.number().int().min(0).max(9).optional(), active: z.boolean().optional() });

export async function updateEscalationContact(actor: Actor, id: string, raw: unknown) {
  assertCan(actor, "automation.pause");
  const input = contactPatch.parse(raw);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; purpose: string; level: number; user_id: string; active: boolean }>(
      "SELECT id, purpose, level, user_id, active FROM escalation_contacts WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [id, actor.orgId],
    );
    const c = rows[0];
    if (!c) throw notFound("người trực");
    const level = input.level ?? c.level;
    const active = input.active ?? c.active;
    if (level !== c.level) {
      const { rows: dup } = await tx.query("SELECT id FROM escalation_contacts WHERE org_id = $1 AND purpose = $2 AND level = $3 AND user_id = $4", [actor.orgId, c.purpose, level, c.user_id]);
      if (dup[0]) throw conflict("duplicate", "Người này đã có ở cấp đó.");
    }
    await tx.query("UPDATE escalation_contacts SET level = $3, active = $4 WHERE id = $1 AND org_id = $2", [id, actor.orgId, level, active]);
    await writeAudit(tx, auditActorOf(actor), "escalation_contact.update", "escalation_contact", id, { before: { level: c.level, active: c.active }, after: { level, active } });
    return { ok: true };
  });
}

export async function removeEscalationContact(actor: Actor, id: string) {
  assertCan(actor, "automation.pause");
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ purpose: string; level: number; user_id: string }>("DELETE FROM escalation_contacts WHERE id = $1 AND org_id = $2 RETURNING purpose, level, user_id", [
      id,
      actor.orgId,
    ]);
    if (!rows[0]) throw notFound("người trực");
    await writeAudit(tx, auditActorOf(actor), "escalation_contact.remove", "escalation_contact", id, rows[0]);
    return { ok: true };
  });
}

// ───────────── Mẫu tin ─────────────

export const TEMPLATE_KEY_RE = /^[a-z][a-z0-9_.]{2,59}$/;

const templateInput = z.object({
  key: z.string().trim().regex(TEMPLATE_KEY_RE, "Mã mẫu: chữ thường, số, gạch dưới, dấu chấm (3–60 ký tự)."),
  language: z.enum(["vi", "en", "de", "hu"]),
  body: z.string().trim().min(5, "Nội dung quá ngắn.").max(1500, "Nội dung tối đa 1500 ký tự."),
});

function canEditTemplates(actor: Actor) {
  return can(actor, "templates.approve") || can(actor, "automation.pause");
}

/**
 * Tạo hoặc sửa mẫu (luôn về trạng thái nháp — sửa mẫu đã duyệt phải duyệt lại).
 * `created_by` = người soạn nội dung hiện hành (người sửa gần nhất) — người này không được tự duyệt (CHECK trong DB).
 */
export async function saveTemplateDraft(actor: Actor, raw: unknown) {
  if (!canEditTemplates(actor)) throw forbidden();
  const input = templateInput.parse(raw);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string; body: string }>("SELECT id, status, body FROM message_templates WHERE org_id = $1 AND key = $2 AND language = $3 FOR UPDATE", [
      actor.orgId,
      input.key,
      input.language,
    ]);
    let id: string;
    if (rows[0]) {
      if (rows[0].body === input.body && rows[0].status === "draft") throw conflict("no_change", "Nội dung không đổi.");
      await tx.query("UPDATE message_templates SET body = $3, status = 'draft', approved_by = NULL, approved_at = NULL, created_by = $4 WHERE id = $1 AND org_id = $2", [rows[0].id, actor.orgId, input.body, actor.userId]);
      id = rows[0].id;
    } else {
      const ins = await tx.query<{ id: string }>("INSERT INTO message_templates (org_id, key, language, body, status, created_by) VALUES ($1,$2,$3,$4,'draft',$5) RETURNING id", [
        actor.orgId,
        input.key,
        input.language,
        input.body,
        actor.userId,
      ]);
      id = ins.rows[0].id;
    }
    await writeAudit(tx, auditActorOf(actor), "template.save", "message_template", id, { key: input.key, language: input.language, previousStatus: rows[0]?.status ?? null });
    return { id };
  });
}

export async function approveTemplate(actor: Actor, id: string) {
  assertCan(actor, "templates.approve");
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; key: string; language: string; status: string; created_by: string | null }>("SELECT id, key, language, status, created_by FROM message_templates WHERE id = $1 AND org_id = $2 FOR UPDATE", [
      id,
      actor.orgId,
    ]);
    const t = rows[0];
    if (!t) throw notFound("mẫu tin");
    if (t.status !== "draft") throw conflict("not_draft", "Chỉ duyệt được mẫu đang nháp.");
    const authorId = t.created_by;
    if (authorId && authorId === actor.userId) throw forbidden("Người soạn mẫu không tự duyệt mẫu của mình.");
    await tx.query("UPDATE message_templates SET status = 'approved', approved_by = $3, approved_at = now() WHERE id = $1 AND org_id = $2", [id, actor.orgId, actor.userId]);
    await writeAudit(tx, auditActorOf(actor), "template.approve", "message_template", id, { key: t.key, language: t.language, author: authorId ?? "không rõ (tạo bằng script)" });
    return { ok: true };
  });
}

export async function retireTemplate(actor: Actor, id: string, raw: unknown) {
  assertCan(actor, "templates.approve");
  const input = z.object({ reason }).parse(raw);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ status: string; key: string }>("SELECT status, key FROM message_templates WHERE id = $1 AND org_id = $2 FOR UPDATE", [id, actor.orgId]);
    if (!rows[0]) throw notFound("mẫu tin");
    if (rows[0].status === "retired") throw conflict("no_change", "Mẫu đã ngừng dùng.");
    await tx.query("UPDATE message_templates SET status = 'retired' WHERE id = $1 AND org_id = $2", [id, actor.orgId]);
    await writeAudit(tx, auditActorOf(actor), "template.retire", "message_template", id, { key: rows[0].key, from: rows[0].status, reason: input.reason });
    return { ok: true };
  });
}

// ───────────── Đăng ký nhận báo cáo ─────────────

const subscriptionInput = z.object({
  userId: z.string().uuid("Chọn người nhận."),
  kind: z.enum(["morning", "evening", "p1_alert"]),
  channel: z.enum(["whatsapp", "inapp"]),
  sendTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Giờ dạng HH:MM.")
    .nullable()
    .optional(),
});

export async function addReportSubscription(actor: Actor, raw: unknown) {
  assertCan(actor, "automation.pause");
  const input = subscriptionInput.parse(raw);
  if (input.kind !== "p1_alert" && !input.sendTime) throw new AppError("invalid_input", "Báo cáo đầu/cuối ngày cần giờ gửi.", 422);
  return withTx(async (tx) => {
    const { rows: u } = await tx.query<{ full_name: string; role: string }>("SELECT full_name, role FROM users WHERE id = $1 AND org_id = $2 AND active", [input.userId, actor.orgId]);
    if (!u[0]) throw notFound("người dùng");
    if (u[0].role === "cleaner") throw new AppError("invalid_input", "Cleaner không nhận báo cáo quản lý.", 422);
    const { rows: dup } = await tx.query("SELECT id FROM report_subscriptions WHERE org_id = $1 AND user_id = $2 AND kind = $3 AND channel = $4", [
      actor.orgId,
      input.userId,
      input.kind,
      input.channel,
    ]);
    if (dup[0]) throw conflict("duplicate", "Người này đã đăng ký loại báo cáo này qua kênh này.");
    // Luôn tạo ở trạng thái TẮT — bật riêng, có lý do.
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO report_subscriptions (org_id, user_id, kind, channel, send_time, enabled) VALUES ($1,$2,$3,$4,$5,false) RETURNING id",
      [actor.orgId, input.userId, input.kind, input.channel, input.sendTime ?? null],
    );
    await writeAudit(tx, auditActorOf(actor), "report_subscription.add", "report_subscription", rows[0].id, { user: u[0].full_name, kind: input.kind, channel: input.channel, sendTime: input.sendTime ?? null });
    return { id: rows[0].id };
  });
}

const subscriptionPatch = z.object({
  enabled: z.boolean().optional(),
  sendTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Giờ dạng HH:MM.")
    .optional(),
  reason: reason.optional(),
});

export async function updateReportSubscription(actor: Actor, id: string, raw: unknown) {
  assertCan(actor, "automation.pause");
  const input = subscriptionPatch.parse(raw);
  if (input.enabled === true && !input.reason) throw new AppError("invalid_input", "Bật gửi báo cáo cần lý do (ví dụ: Ngọc đã chốt giờ).", 422);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ enabled: boolean; send_time: string | null; kind: string }>(
      "SELECT enabled, send_time::text, kind FROM report_subscriptions WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [id, actor.orgId],
    );
    const s = rows[0];
    if (!s) throw notFound("đăng ký báo cáo");
    const enabled = input.enabled ?? s.enabled;
    const sendTime = input.sendTime ?? s.send_time;
    if (enabled && s.kind !== "p1_alert" && !sendTime) throw new AppError("invalid_input", "Cần giờ gửi trước khi bật.", 422);
    await tx.query("UPDATE report_subscriptions SET enabled = $3, send_time = $4 WHERE id = $1 AND org_id = $2", [id, actor.orgId, enabled, sendTime]);
    await writeAudit(tx, auditActorOf(actor), "report_subscription.update", "report_subscription", id, {
      before: { enabled: s.enabled, sendTime: s.send_time },
      after: { enabled, sendTime },
      reason: input.reason ?? null,
    });
    return { ok: true };
  });
}

export async function removeReportSubscription(actor: Actor, id: string) {
  assertCan(actor, "automation.pause");
  return withTx(async (tx) => {
    const { rows } = await tx.query("DELETE FROM report_subscriptions WHERE id = $1 AND org_id = $2 RETURNING kind, channel, user_id", [id, actor.orgId]);
    if (!rows[0]) throw notFound("đăng ký báo cáo");
    await writeAudit(tx, auditActorOf(actor), "report_subscription.remove", "report_subscription", id, rows[0]);
    return { ok: true };
  });
}

