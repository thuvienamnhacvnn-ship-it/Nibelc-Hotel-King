import { query, queryOne } from "@/lib/db";
import type { PageParams } from "@/lib/http";
import { addDays, isValidDate, localToUtc } from "@/lib/time";
import { type Actor, can } from "@/modules/auth/actor";

/**
 * Nhật ký audit (quyền audit.view). Lọc theo loại đối tượng, hành động, người, khoảng ngày (ngày theo giờ Budapest).
 * Người không có booking.view_guest_contact không thấy tên/liên hệ khách trong chi tiết.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUEST_KEYS = /^(guest|guest_?name|full_?name|email|phone|guestName|fullName)$/i;

export interface AuditFilter {
  entityType?: string | null;
  action?: string | null;
  /** uuid người dùng, hoặc "system:<actor_type>" cho tác nhân không phải người */
  actor?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface AuditRow {
  id: number;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: unknown;
  ip: string | null;
  created_at: Date;
}

function redactGuest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactGuest);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, GUEST_KEYS.test(k) ? "[ẩn — cần quyền xem liên hệ khách]" : redactGuest(v)]));
  }
  return value;
}

export async function listAudit(actor: Actor, filter: AuditFilter, page: PageParams) {
  const tz = actor.timezone;
  const from = filter.from && isValidDate(filter.from) ? localToUtc(filter.from, "00:00", tz) : null;
  const to = filter.to && isValidDate(filter.to) ? localToUtc(addDays(filter.to, 1), "00:00", tz) : null;
  let actorId: string | null = null;
  let actorType: string | null = null;
  if (filter.actor && UUID_RE.test(filter.actor)) actorId = filter.actor;
  else if (filter.actor?.startsWith("system:")) actorType = filter.actor.slice(7);

  const params = [actor.orgId, filter.entityType || null, filter.action || null, actorId, actorType, from, to];
  const where = `l.org_id = $1
    AND ($2::text IS NULL OR l.entity_type = $2::text)
    AND ($3::text IS NULL OR l.action = $3::text)
    AND ($4::uuid IS NULL OR l.actor_id = $4::uuid)
    AND ($5::text IS NULL OR (l.actor_type = $5::text AND l.actor_id IS NULL))
    AND ($6::timestamptz IS NULL OR l.created_at >= $6::timestamptz)
    AND ($7::timestamptz IS NULL OR l.created_at < $7::timestamptz)`;
  const [rows, total] = await Promise.all([
    query<AuditRow>(
      `SELECT l.id::int AS id, l.actor_type, l.actor_id, u.full_name AS actor_name, l.action, l.entity_type, l.entity_id, l.detail, l.ip, l.created_at
         FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id AND u.org_id = $1
        WHERE ${where}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $8 OFFSET $9`,
      [...params, page.pageSize, page.offset],
    ),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log l WHERE ${where}`, params),
  ]);
  const showGuest = can(actor, "booking.view_guest_contact");
  const items = rows.map((r) => ({ ...r, detail: showGuest ? r.detail : redactGuest(r.detail) }));
  return { items, page: page.page, pageSize: page.pageSize, total: total?.n ?? 0 };
}

/** Giá trị cho bộ lọc — chỉ lấy những gì đã có trong nhật ký của tổ chức. */
export async function auditFilterOptions(actor: Actor) {
  const [entityTypes, actions, actors] = await Promise.all([
    query<{ v: string }>("SELECT DISTINCT entity_type AS v FROM audit_log WHERE org_id = $1 ORDER BY 1", [actor.orgId]),
    query<{ v: string }>("SELECT DISTINCT action AS v FROM audit_log WHERE org_id = $1 ORDER BY 1", [actor.orgId]),
    query<{ value: string; label: string }>(
      `SELECT DISTINCT coalesce(l.actor_id::text, 'system:' || l.actor_type) AS value,
              coalesce(u.full_name, CASE l.actor_type WHEN 'connector' THEN 'Connector (hệ thống)' WHEN 'import' THEN 'Nhập Excel (hệ thống)' WHEN 'agent' THEN 'Agent' ELSE 'Hệ thống' END) AS label
         FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id AND u.org_id = $1
        WHERE l.org_id = $1 ORDER BY 2`,
      [actor.orgId],
    ),
  ]);
  return { entityTypes: entityTypes.map((r) => r.v), actions: actions.map((r) => r.v), actors };
}
