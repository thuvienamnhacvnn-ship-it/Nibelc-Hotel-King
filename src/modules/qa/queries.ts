import { query, queryOne } from "@/lib/db";
import type { PageParams } from "@/lib/http";
import { type Actor, assertCan } from "@/modules/auth/actor";
import { QA_SCOPES, QA_STATUSES } from "./labels";
import type { QaEntryRow } from "./service";

/** Truy vấn đọc cho màn hình Kho Q&A. Chỉ đọc — mọi thay đổi đi qua service.ts. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QaFilters {
  scope: string | null;
  propertyId: string | null;
  unitId: string | null;
  /** null = mọi trạng thái trừ "ngưng dùng" */
  status: string | null;
  topic: string | null;
  q: string | null;
}

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;
function param(src: ParamSource, key: string): string | null {
  const v = src instanceof URLSearchParams ? src.get(key) : src[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim().slice(0, 200) : null;
}

export function parseQaFilters(src: ParamSource): QaFilters {
  const pick = (key: string, allowed: readonly string[]) => {
    const v = param(src, key);
    return v && allowed.includes(v) ? v : null;
  };
  const uuid = (key: string) => {
    const v = param(src, key);
    return v && UUID_RE.test(v) ? v : null;
  };
  return {
    scope: pick("scope", QA_SCOPES),
    propertyId: uuid("property"),
    unitId: uuid("unit"),
    status: pick("status", [...QA_STATUSES, "all"]),
    topic: param(src, "topic"),
    q: param(src, "q"),
  };
}

export type QaListItem = QaEntryRow & {
  property_code: string | null;
  unit_code: string | null;
  created_by_name: string | null;
  approved_by_name: string | null;
  version_count: number;
  last_reject_reason: string | null;
};

export async function listQaEntries(actor: Actor, f: QaFilters, page: PageParams) {
  assertCan(actor, "qa.view");
  const where = ["e.org_id = $1"];
  const params: unknown[] = [actor.orgId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.status === null) where.push("e.status <> 'retired'");
  else if (f.status !== "all") add("e.status = ?", f.status);
  if (f.scope) add("e.scope = ?", f.scope);
  // Lọc theo nhà gồm cả mục theo phòng của nhà đó (property_id được ghi kèm).
  if (f.propertyId) add("e.property_id = ?", f.propertyId);
  if (f.unitId) add("e.unit_id = ?", f.unitId);
  if (f.topic) add("lower(e.topic) = lower(?)", f.topic);
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const p = `$${params.length}`;
    where.push(`(e.question ILIKE ${p} OR e.answer_en ILIKE ${p} OR coalesce(e.answer_vi,'') ILIKE ${p} OR e.topic ILIKE ${p} OR array_to_string(e.variants, ' ') ILIKE ${p})`);
  }
  const whereSql = where.join(" AND ");
  const total = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM qa_entries e WHERE ${whereSql}`, params))!.n;
  const items = await query<QaListItem>(
    `SELECT e.*, p.code AS property_code, u.code AS unit_code, cu.full_name AS created_by_name, au.full_name AS approved_by_name,
            (SELECT count(*)::int FROM qa_entries v WHERE v.org_id = e.org_id AND v.entry_key = e.entry_key) AS version_count,
            (SELECT a.detail->>'reason' FROM audit_log a
              WHERE a.org_id = e.org_id AND a.entity_type = 'qa_entry' AND a.entity_id = e.id::text AND a.action = 'qa.reject'
              ORDER BY a.created_at DESC LIMIT 1) AS last_reject_reason
       FROM qa_entries e
       LEFT JOIN properties p ON p.id = e.property_id AND p.org_id = e.org_id
       LEFT JOIN units u ON u.id = e.unit_id AND u.org_id = e.org_id
       LEFT JOIN users cu ON cu.id = e.created_by
       LEFT JOIN users au ON au.id = e.approved_by
      WHERE ${whereSql}
      ORDER BY CASE e.status WHEN 'pending_review' THEN 0 WHEN 'draft' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
               lower(e.topic), CASE e.scope WHEN 'general' THEN 0 WHEN 'property' THEN 1 ELSE 2 END, e.question, e.version DESC
      LIMIT ${page.pageSize} OFFSET ${page.offset}`,
    params,
  );
  return { items, page: page.page, pageSize: page.pageSize, total };
}

/** Mọi phiên bản của cùng câu hỏi (theo id một phiên bản), mới nhất trước, kèm nhật ký. */
export async function qaEntryHistory(actor: Actor, id: string) {
  assertCan(actor, "qa.view");
  if (!UUID_RE.test(id)) return null;
  const base = await queryOne<{ entry_key: string }>("SELECT entry_key FROM qa_entries WHERE id = $1 AND org_id = $2", [id, actor.orgId]);
  if (!base) return null;
  const versions = await query<QaListItem>(
    `SELECT e.*, p.code AS property_code, u.code AS unit_code, cu.full_name AS created_by_name, au.full_name AS approved_by_name,
            0 AS version_count, NULL AS last_reject_reason
       FROM qa_entries e
       LEFT JOIN properties p ON p.id = e.property_id AND p.org_id = e.org_id
       LEFT JOIN units u ON u.id = e.unit_id AND u.org_id = e.org_id
       LEFT JOIN users cu ON cu.id = e.created_by
       LEFT JOIN users au ON au.id = e.approved_by
      WHERE e.org_id = $1 AND e.entry_key = $2
      ORDER BY e.version DESC`,
    [actor.orgId, base.entry_key],
  );
  const events = await query<{ id: number; action: string; entity_id: string; detail: Record<string, unknown> | null; created_at: Date; actor_name: string | null; actor_type: string }>(
    `SELECT a.id, a.action, a.entity_id, a.detail, a.created_at, a.actor_type, us.full_name AS actor_name
       FROM audit_log a LEFT JOIN users us ON us.id = a.actor_id
      WHERE a.org_id = $1 AND a.entity_type = 'qa_entry' AND a.entity_id = ANY($2::text[])
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 200`,
    [actor.orgId, versions.map((v) => v.id)],
  );
  return { entryKey: base.entry_key, versions, events };
}

export async function qaTopics(actor: Actor) {
  assertCan(actor, "qa.view");
  return (await query<{ topic: string }>("SELECT DISTINCT topic FROM qa_entries WHERE org_id = $1 ORDER BY topic", [actor.orgId])).map((r) => r.topic);
}

export async function qaStatusCounts(actor: Actor) {
  assertCan(actor, "qa.view");
  const rows = await query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM qa_entries WHERE org_id = $1 GROUP BY status", [actor.orgId]);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
}

