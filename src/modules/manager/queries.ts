import { query, queryOne } from "@/lib/db";
import type { PageParams } from "@/lib/http";
import type { Actor } from "@/modules/auth/actor";
import { AGENT_KEYS, CHANNEL_KEYS } from "@/modules/automation/switches";
import type { DailyReportData } from "./report";

/** Truy vấn đọc cho /bao-cao và /agent-center. Mọi câu lọc org_id của phiên. */

export async function listReports(actor: Actor, limit = 30) {
  return query<{ id: string; kind: string; ops_date: string; cutoff_at: Date; status: string; created_at: Date; generated_by_name: string | null; sources_failed: number }>(
    `SELECT r.id, r.kind, r.ops_date, r.cutoff_at, r.status, r.created_at, u.full_name AS generated_by_name,
            coalesce(jsonb_array_length(r.data->'sourcesFailed'), 0) AS sources_failed
       FROM manager_reports r LEFT JOIN users u ON u.id = r.generated_by
      WHERE r.org_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [actor.orgId, limit],
  );
}

export async function getReport(actor: Actor, id: string) {
  return queryOne<{ id: string; kind: string; ops_date: string; cutoff_at: Date; status: string; created_at: Date; data: DailyReportData; narrative: string | null; generated_by_name: string | null }>(
    `SELECT r.id, r.kind, r.ops_date, r.cutoff_at, r.status, r.created_at, r.data, r.narrative, u.full_name AS generated_by_name
       FROM manager_reports r LEFT JOIN users u ON u.id = r.generated_by
      WHERE r.id = $1 AND r.org_id = $2`,
    [id, actor.orgId],
  );
}

export async function latestReportFor(actor: Actor, opsDate: string, kind: string) {
  return queryOne<{ id: string }>("SELECT id FROM manager_reports WHERE org_id = $1 AND ops_date = $2 AND kind = $3 ORDER BY created_at DESC LIMIT 1", [actor.orgId, opsDate, kind]);
}

export interface SwitchState {
  scope: "org" | "agent" | "channel";
  key: string;
  exists: boolean;
  paused: boolean;
  reason: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** Trạng thái mọi công tắc. Trợ lý/kênh chưa có bản ghi = đang DỪNG (mặc định an toàn). Tổ chức chưa có bản ghi = không chặn. */
export async function listSwitches(actor: Actor): Promise<SwitchState[]> {
  const rows = await query<{ scope: string; scope_key: string; paused: boolean; reason: string | null; updated_at: Date; updated_by_name: string | null }>(
    `SELECT s.scope, s.scope_key, s.paused, s.reason, s.updated_at, u.full_name AS updated_by_name
       FROM automation_switches s LEFT JOIN users u ON u.id = s.updated_by WHERE s.org_id = $1`,
    [actor.orgId],
  );
  const find = (scope: string, key: string) => rows.find((r) => r.scope === scope && r.scope_key === key);
  const make = (scope: SwitchState["scope"], key: string, defaultPaused: boolean): SwitchState => {
    const r = find(scope, key);
    return { scope, key, exists: !!r, paused: r ? r.paused : defaultPaused, reason: r?.reason ?? null, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by_name ?? null };
  };
  return [make("org", "", false), ...AGENT_KEYS.map((k) => make("agent", k, true)), ...CHANNEL_KEYS.map((k) => make("channel", k, true))];
}

export const AGENT_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "skipped_paused"] as const;

export async function listAgentRuns(actor: Actor, status: string | null, p: PageParams) {
  const st = status && (AGENT_RUN_STATUSES as readonly string[]).includes(status) ? status : null;
  const where = "org_id = $1 AND ($2::text IS NULL OR status = $2)";
  const items = await query<{
    id: string;
    agent_role: string;
    task_key: string;
    entity_type: string | null;
    status: string;
    attempt: number;
    max_attempts: number;
    budget_minor: number;
    cost_minor: number;
    error: string | null;
    created_at: Date;
    finished_at: Date | null;
    heartbeat_at: Date | null;
  }>(
    `SELECT id, agent_role, task_key, entity_type, status, attempt, max_attempts, budget_minor, cost_minor, error, created_at, finished_at, heartbeat_at
       FROM agent_runs WHERE ${where} ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [actor.orgId, st, p.pageSize, p.offset],
  );
  const total = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM agent_runs WHERE ${where}`, [actor.orgId, st]);
  return { items, page: p.page, pageSize: p.pageSize, total: total?.n ?? 0, status: st };
}

export async function aiBudget(actor: Actor) {
  return (await queryOne<{ runs: number; budget: number; cost: number }>(
    "SELECT count(*)::int AS runs, coalesce(sum(budget_minor), 0)::int AS budget, coalesce(sum(cost_minor), 0)::int AS cost FROM agent_runs WHERE org_id = $1",
    [actor.orgId],
  ))!;
}

export async function listOutbox(actor: Actor, status: string | null, p: PageParams) {
  const st = status === "dead" || status === "pending" || status === "processing" ? status : null;
  const where = `org_id = $1 AND (${st ? "status = $2" : "status IN ('dead','pending','processing') AND $2::text IS NULL"})`;
  const items = await query<{ id: string; topic: string; aggregate_type: string; status: string; attempts: number; max_attempts: number; last_error: string | null; created_at: Date; available_at: Date }>(
    `SELECT id, topic, aggregate_type, status, attempts, max_attempts, last_error, created_at, available_at
       FROM outbox_events WHERE ${where} ORDER BY status = 'dead' DESC, created_at DESC LIMIT $3 OFFSET $4`,
    [actor.orgId, st, p.pageSize, p.offset],
  );
  const total = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE ${where}`, [actor.orgId, st]);
  return { items, page: p.page, pageSize: p.pageSize, total: total?.n ?? 0, status: st };
}

export const NOTIFICATION_STATUSES = ["queued", "sending", "sent", "failed", "suppressed"] as const;

export async function listStaffNotifications(actor: Actor, status: string | null, p: PageParams, opts: { onlyMine?: boolean } = {}) {
  const st = status && (NOTIFICATION_STATUSES as readonly string[]).includes(status) ? status : null;
  const where = "n.org_id = $1 AND ($2::text IS NULL OR n.status = $2) AND ($3::uuid IS NULL OR n.recipient_user_id = $3)";
  const params = [actor.orgId, st, opts.onlyMine ? actor.userId : null];
  const items = await query<{
    id: string;
    recipient_name: string;
    channel: string;
    template_key: string;
    status: string;
    suppressed_reason: string | null;
    error: string | null;
    attempts: number;
    rendered_body: string | null;
    payload: Record<string, unknown>;
    created_at: Date;
    sent_at: Date | null;
  }>(
    `SELECT n.id, u.full_name AS recipient_name, n.channel, n.template_key, n.status, n.suppressed_reason, n.error, n.attempts, n.rendered_body, n.payload, n.created_at, n.sent_at
       FROM staff_notifications n JOIN users u ON u.id = n.recipient_user_id
      WHERE ${where} ORDER BY n.created_at DESC LIMIT $4 OFFSET $5`,
    [...params, p.pageSize, p.offset],
  );
  const total = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM staff_notifications n WHERE ${where}`, params);
  const counts = await query<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM staff_notifications WHERE org_id = $1 AND ($2::uuid IS NULL OR recipient_user_id = $2) GROUP BY status",
    [actor.orgId, opts.onlyMine ? actor.userId : null],
  );
  return { items, page: p.page, pageSize: p.pageSize, total: total?.n ?? 0, status: st, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number> };
}

export async function listTemplates(actor: Actor) {
  return query<{ id: string; key: string; language: string; body: string; status: string; approved_by_name: string | null; approved_at: Date | null; created_at: Date; author_id: string | null; author_name: string | null }>(
    `SELECT t.id, t.key, t.language, t.body, t.status, ap.full_name AS approved_by_name, t.approved_at, t.created_at, t.created_by AS author_id, au.full_name AS author_name
       FROM message_templates t
       LEFT JOIN users ap ON ap.id = t.approved_by
       LEFT JOIN users au ON au.id = t.created_by
      WHERE t.org_id = $1 ORDER BY t.key, t.language`,
    [actor.orgId],
  );
}

export async function listEscalationContacts(actor: Actor) {
  return query<{ id: string; purpose: string; level: number; user_id: string; full_name: string; role: string; active: boolean; user_active: boolean; has_phone: boolean }>(
    `SELECT ec.id, ec.purpose, ec.level, ec.user_id, u.full_name, u.role, ec.active, u.active AS user_active, (coalesce(u.phone, '') <> '') AS has_phone
       FROM escalation_contacts ec JOIN users u ON u.id = ec.user_id
      WHERE ec.org_id = $1 ORDER BY ec.purpose, ec.level, u.full_name`,
    [actor.orgId],
  );
}

export async function listSubscriptions(actor: Actor) {
  return query<{ id: string; user_id: string; full_name: string; kind: string; channel: string; send_time: string | null; enabled: boolean }>(
    `SELECT s.id, s.user_id, u.full_name, s.kind, s.channel, s.send_time::text, s.enabled
       FROM report_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.org_id = $1 ORDER BY u.full_name, s.kind`,
    [actor.orgId],
  );
}

/** Người trong tổ chức có thể chọn làm người trực / người nhận báo cáo (không gồm cleaner). */
export async function staffOptions(actor: Actor) {
  return query<{ id: string; full_name: string; role: string; duties: string[] }>(
    "SELECT id, full_name, role, duties FROM users WHERE org_id = $1 AND active AND role <> 'cleaner' ORDER BY full_name",
    [actor.orgId],
  );
}

export async function workerStatus() {
  return queryOne<{ last_beat_at: Date; detail: Record<string, unknown> }>("SELECT last_beat_at, detail FROM system_heartbeats WHERE name = 'worker'");
}
