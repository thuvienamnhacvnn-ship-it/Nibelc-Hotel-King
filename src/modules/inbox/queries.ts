import { query, queryOne } from "@/lib/db";
import { isUuid } from "@/lib/http";
import { type Actor, assertCan, can } from "@/modules/auth/actor";

/** Truy vấn đọc cho hộp thư. Mọi câu lọc org_id = actor.orgId. Liên hệ khách chỉ hiện khi có booking.view_guest_contact. */

export * from "./labels";
import { CONVERSATION_KINDS, INBOX_CHANNEL_LABELS } from "./labels";

export interface InboxFilters {
  kind: (typeof CONVERSATION_KINDS)[number] | null;
  unread: boolean;
  waiting: boolean;
  channel: string | null;
}

export function parseInboxFilters(get: (k: string) => string | null): InboxFilters {
  const kind = get("kind");
  const channel = get("channel");
  return {
    kind: (CONVERSATION_KINDS as readonly string[]).includes(kind ?? "") ? (kind as InboxFilters["kind"]) : null,
    unread: get("unread") === "1",
    waiting: get("waiting") === "1",
    channel: channel && channel in INBOX_CHANNEL_LABELS ? channel : null,
  };
}

export interface ConversationListItem {
  id: string;
  channel: string;
  kind: string;
  title: string | null;
  contact_name: string | null;
  contact_handle: string | null;
  handled_by: "bot" | "human";
  takeover_name: string | null;
  status: string;
  verification_level: string;
  booking_ref: string | null;
  unit_code: string | null;
  unread_count: number;
  last_message_at: Date | null;
  last_body: string | null;
  last_direction: string | null;
  drafts: number;
  open_handoffs: number;
  failed: number;
  is_demo: boolean;
  connector_label: string | null;
  connector_status: string | null;
}

export async function listConversations(actor: Actor, f: InboxFilters, page: { page: number; pageSize: number; offset: number }) {
  assertCan(actor, "inbox.view");
  const where = ["c.org_id = $1"];
  const params: unknown[] = [actor.orgId];
  if (f.kind) {
    params.push(f.kind);
    where.push(`c.kind = $${params.length}`);
  }
  if (f.channel) {
    params.push(f.channel);
    where.push(`c.channel = $${params.length}`);
  }
  if (f.unread) where.push("c.unread_count > 0");
  if (f.waiting) where.push("EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id AND h.org_id = c.org_id AND h.status IN ('requested','escalated'))");
  const whereSql = where.join(" AND ");
  const total = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM conversations c WHERE ${whereSql}`, params);
  const showContact = can(actor, "booking.view_guest_contact");
  const showBooking = can(actor, "booking.view");
  const items = await query<ConversationListItem>(
    `SELECT c.id, c.channel, c.kind, c.title, c.contact_name, c.contact_handle, c.handled_by, tu.full_name AS takeover_name, c.status, c.verification_level,
            b.external_ref AS booking_ref, un.code AS unit_code, c.unread_count, c.last_message_at, c.is_demo,
            lm.body AS last_body, lm.direction AS last_direction,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.status IN ('draft','pending_approval')) AS drafts,
            (SELECT count(*)::int FROM handoffs h WHERE h.conversation_id = c.id AND h.status IN ('requested','escalated')) AS open_handoffs,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.status = 'failed') AS failed,
            ca.label AS connector_label, ca.status AS connector_status
       FROM conversations c
       LEFT JOIN users tu ON tu.id = c.takeover_by AND tu.org_id = c.org_id
       LEFT JOIN bookings b ON b.id = c.booking_id AND b.org_id = c.org_id
       LEFT JOIN units un ON un.id = c.unit_id AND un.org_id = c.org_id
       LEFT JOIN connector_accounts ca ON ca.id = c.connector_id AND ca.org_id = c.org_id
       LEFT JOIN LATERAL (SELECT body, direction FROM messages m WHERE m.conversation_id = c.id AND m.status <> 'discarded' ORDER BY m.created_at DESC LIMIT 1) lm ON true
      WHERE ${whereSql}
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.pageSize, page.offset],
  );
  for (const it of items) {
    if (!showContact && it.kind !== "staff") it.contact_handle = null;
    if (!showBooking && it.booking_ref) it.booking_ref = "Đã gắn booking";
    if (it.last_body && it.last_body.length > 140) it.last_body = `${it.last_body.slice(0, 140)}…`;
  }
  return { items, page: page.page, pageSize: page.pageSize, total: total?.n ?? 0 };
}

export interface MessageView {
  id: string;
  direction: "in" | "out" | "note";
  author_type: string;
  author_name: string | null;
  body: string | null;
  attachments: { kind: string }[];
  status: string;
  error: string | null;
  grounding: {
    entryId?: string;
    entryKey?: string;
    version?: number;
    scope?: string;
    topic?: string;
    score?: number;
    language?: string;
    sensitivity?: string;
    editedByStaff?: boolean;
  } | null;
  approved_name: string | null;
  created_at: Date;
  sent_at: Date | null;
  locked_at: Date | null;
  source_occurred_at: Date | null;
}

export async function getConversationDetail(actor: Actor, conversationId: string) {
  assertCan(actor, "inbox.view");
  if (!isUuid(conversationId)) return null;
  const conv = await queryOne<{
    id: string;
    channel: string;
    kind: string;
    title: string | null;
    contact_name: string | null;
    contact_handle: string | null;
    staff_name: string | null;
    handled_by: "bot" | "human";
    takeover_by: string | null;
    takeover_name: string | null;
    takeover_at: Date | null;
    status: string;
    verification_level: string;
    booking_id: string | null;
    booking_ref: string | null;
    booking_check_in: string | null;
    booking_check_out: string | null;
    unit_code: string | null;
    language: string | null;
    unread_count: number;
    is_demo: boolean;
    connector_id: string | null;
    connector_label: string | null;
    connector_status: string | null;
    connector_paused: boolean | null;
  }>(
    `SELECT c.id, c.channel, c.kind, c.title, c.contact_name, c.contact_handle, su.full_name AS staff_name, c.handled_by, c.takeover_by, tu.full_name AS takeover_name, c.takeover_at,
            c.status, c.verification_level, c.booking_id, b.external_ref AS booking_ref, b.check_in_date AS booking_check_in, b.check_out_date AS booking_check_out,
            un.code AS unit_code, c.language, c.unread_count, c.is_demo, c.connector_id, ca.label AS connector_label, ca.status AS connector_status, ca.paused AS connector_paused
       FROM conversations c
       LEFT JOIN users su ON su.id = c.staff_user_id AND su.org_id = c.org_id
       LEFT JOIN users tu ON tu.id = c.takeover_by AND tu.org_id = c.org_id
       LEFT JOIN bookings b ON b.id = c.booking_id AND b.org_id = c.org_id
       LEFT JOIN units un ON un.id = c.unit_id AND un.org_id = c.org_id
       LEFT JOIN connector_accounts ca ON ca.id = c.connector_id AND ca.org_id = c.org_id
      WHERE c.id = $1 AND c.org_id = $2`,
    [conversationId, actor.orgId],
  );
  if (!conv) return null;
  if (!can(actor, "booking.view_guest_contact") && conv.kind !== "staff") conv.contact_handle = null;
  if (!can(actor, "booking.view")) {
    conv.booking_ref = conv.booking_ref ? "(đã gắn)" : null;
    conv.booking_id = null;
    conv.booking_check_in = null;
    conv.booking_check_out = null;
  }

  const messages = await query<MessageView>(
      `SELECT * FROM (
         SELECT m.id, m.direction, m.author_type, m.author_name, m.body, m.attachments, m.status, m.error, m.grounding, au.full_name AS approved_name,
                m.created_at, m.sent_at, m.locked_at, m.source_occurred_at
           FROM messages m LEFT JOIN users au ON au.id = m.approved_by AND au.org_id = m.org_id
          WHERE m.conversation_id = $1 AND m.org_id = $2
          ORDER BY m.created_at DESC LIMIT 200) t
       ORDER BY created_at ASC`,
      [conversationId, actor.orgId],
  );

  const tickets = await query<{
    id: string;
    category: string;
    priority: string;
    status: string;
    summary: string;
    assignee_user_id: string | null;
    assignee_name: string | null;
    accept_due_at: Date | null;
    accepted_at: Date | null;
    version: number;
    created_by_type: string;
    created_at: Date;
  }>(
    `SELECT t.id, t.category, t.priority, t.status, t.summary, t.assignee_user_id, u.full_name AS assignee_name, t.accept_due_at, t.accepted_at, t.version, t.created_by_type, t.created_at
       FROM tickets t LEFT JOIN users u ON u.id = t.assignee_user_id AND u.org_id = t.org_id
      WHERE t.conversation_id = $1 AND t.org_id = $2 ORDER BY t.created_at DESC LIMIT 50`,
    [conversationId, actor.orgId],
  );

  const handoffs = await query<{
    id: string;
    reason: string;
    status: string;
    context: Record<string, unknown>;
    target_name: string | null;
    accepted_name: string | null;
    requested_at: Date;
    accept_due_at: Date | null;
    accepted_at: Date | null;
    ticket_id: string | null;
  }>(
    `SELECT h.id, h.reason, h.status, h.context, tu.full_name AS target_name, au.full_name AS accepted_name, h.requested_at, h.accept_due_at, h.accepted_at, h.ticket_id
       FROM handoffs h
       LEFT JOIN users tu ON tu.id = h.target_user_id AND tu.org_id = h.org_id
       LEFT JOIN users au ON au.id = h.accepted_by AND au.org_id = h.org_id
      WHERE h.conversation_id = $1 AND h.org_id = $2 ORDER BY h.requested_at DESC LIMIT 50`,
    [conversationId, actor.orgId],
  );

  return { conversation: conv, messages, tickets, handoffs };
}

export type ConversationDetail = NonNullable<Awaited<ReturnType<typeof getConversationDetail>>>;

/** Connector nhắn tin của tổ chức — để giao diện nói rõ demo / chưa cấu hình / thử nghiệm. */
export async function listMessagingConnectors(actor: Actor) {
  assertCan(actor, "inbox.view");
  return query<{ id: string; channel: string; label: string; status: string; paused: boolean; webhook_ready: boolean; last_inbound_at: Date | null }>(
    `SELECT ca.id, ca.channel, ca.label, ca.status, ca.paused, (ca.webhook_secret_hash IS NOT NULL) AS webhook_ready,
            (SELECT max(c.last_inbound_at) FROM conversations c WHERE c.connector_id = ca.id AND c.org_id = ca.org_id) AS last_inbound_at
       FROM connector_accounts ca
      WHERE ca.org_id = $1 AND ca.channel IN ('whatsapp','viber','webapp')
      ORDER BY ca.channel, ca.label`,
    [actor.orgId],
  );
}

/** Công tắc gửi tin liên quan hộp thư (mặc định DỪNG khi chưa có bản ghi). */
export async function inboxSwitches(actor: Actor) {
  assertCan(actor, "inbox.view");
  const rows = await query<{ scope: string; scope_key: string; paused: boolean; reason: string | null }>(
    `SELECT scope, scope_key, paused, reason FROM automation_switches
      WHERE org_id = $1 AND ((scope = 'org' AND scope_key = '') OR (scope = 'agent' AND scope_key = 'guest') OR (scope = 'channel' AND scope_key IN ('whatsapp_guest','whatsapp_staff')))`,
    [actor.orgId],
  );
  const state = (scope: string, key: string) => {
    const r = rows.find((x) => x.scope === scope && x.scope_key === key);
    return { paused: r ? r.paused : scope !== "org", configured: !!r, reason: r?.reason ?? null };
  };
  return { org: state("org", ""), agentGuest: state("agent", "guest"), whatsappGuest: state("channel", "whatsapp_guest"), whatsappStaff: state("channel", "whatsapp_staff") };
}

export async function assignableUsers(actor: Actor) {
  assertCan(actor, "inbox.view");
  return query<{ id: string; full_name: string; role: string }>(
    "SELECT id, full_name, role FROM users WHERE org_id = $1 AND active AND role <> 'cleaner' ORDER BY full_name",
    [actor.orgId],
  );
}

/** Tìm booking để gắn thủ công — chỉ người có booking.view; tên khách chỉ hiện khi có quyền xem liên hệ. */
export async function searchBookingsByRef(actor: Actor, ref: string) {
  assertCan(actor, "booking.view");
  const q = ref.trim();
  if (q.length < 3) return [];
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = await query<{ id: string; external_ref: string | null; source_channel: string; booking_status: string; check_in_date: string; check_out_date: string; guest_name: string | null; units: string | null; is_demo: boolean }>(
    `SELECT b.id, b.external_ref, b.source_channel, b.booking_status, b.check_in_date, b.check_out_date, g.full_name AS guest_name, b.is_demo,
            (SELECT string_agg(DISTINCT u.code, ', ') FROM booking_allocations a JOIN units u ON u.id = a.unit_id WHERE a.booking_id = b.id AND a.status = 'active') AS units
       FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id AND g.org_id = b.org_id
      WHERE b.org_id = $1 AND b.external_ref ILIKE $2
      ORDER BY b.check_in_date DESC LIMIT 10`,
    [actor.orgId, like],
  );
  if (!can(actor, "booking.view_guest_contact")) for (const r of rows) r.guest_name = null;
  return rows;
}

/** Worker có đang chạy không (chỉ worker gửi tin) + số tin chờ gửi của tổ chức. */
export async function senderHeartbeat(actor: Actor) {
  assertCan(actor, "inbox.view");
  const row = await queryOne<{ last_beat_at: Date | null; alive: boolean | null; queued: number }>(
    `SELECT (SELECT last_beat_at FROM system_heartbeats WHERE name = 'worker') AS last_beat_at,
            (SELECT last_beat_at > now() - interval '1 minute' FROM system_heartbeats WHERE name = 'worker') AS alive,
            (SELECT count(*)::int FROM messages WHERE org_id = $1 AND direction = 'out' AND status IN ('queued','sending')) AS queued`,
    [actor.orgId],
  );
  return { lastBeatAt: row?.last_beat_at ?? null, alive: row?.alive ?? false, queued: row?.queued ?? 0 };
}
