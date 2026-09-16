import { query, queryOne } from "@/lib/db";
import { type Actor, assertCan, can } from "@/modules/auth/actor";
import { DISPOSITIONS, type Disposition, GUEST_CONTACT_FIELDS, ISSUE_DEFS, type ParsedFields, type RawRow, type RowIssue, fieldOfHeader } from "./excel";

export interface BatchListItem {
  id: string;
  file_name: string;
  file_sha256: string;
  status: "previewed" | "applied" | "discarded";
  stats: Record<string, unknown>;
  options: Record<string, unknown>;
  created_at: Date;
  created_by_name: string | null;
  applied_at: Date | null;
  applied_by_name: string | null;
}

const BATCH_SELECT = `SELECT b.id, b.file_name, b.file_sha256, b.status, b.stats, b.options, b.created_at, cu.full_name AS created_by_name,
                             b.applied_at, au.full_name AS applied_by_name
                        FROM import_batches b
                        LEFT JOIN users cu ON cu.id = b.created_by
                        LEFT JOIN users au ON au.id = b.applied_by`;

export async function listImportBatches(actor: Actor, page: { page: number; pageSize: number; offset: number }) {
  assertCan(actor, "import.preview");
  const items = await query<BatchListItem>(`${BATCH_SELECT} WHERE b.org_id = $1 ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`, [
    actor.orgId,
    page.pageSize,
    page.offset,
  ]);
  const total = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM import_batches WHERE org_id = $1", [actor.orgId]);
  return { items, page: page.page, pageSize: page.pageSize, total: total?.n ?? 0 };
}

export async function getImportBatch(actor: Actor, batchId: string): Promise<BatchListItem | null> {
  assertCan(actor, "import.preview");
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return null;
  return queryOne<BatchListItem>(`${BATCH_SELECT} WHERE b.id = $1 AND b.org_id = $2`, [batchId, actor.orgId]);
}

export interface ImportRowItem {
  id: string;
  sheet: string;
  row_number: number;
  raw: RawRow;
  parsed: ParsedFields | null;
  issues: RowIssue[];
  disposition: Disposition;
  source_key: string | null;
  booking_id: string | null;
}

export interface RowFilter {
  disposition?: string | null;
  issue?: string | null;
  sheet?: string | null;
}

/**
 * Ẩn ở server: tên/SĐT khách khi thiếu booking.view_guest_contact; ghi chú có khoản thu khi thiếu revenue.view
 * (cả giá trị gốc lẫn giá trị đã hiểu).
 */
export function redactRow(actor: Actor, row: ImportRowItem): ImportRowItem {
  const hideContact = !can(actor, "booking.view_guest_contact");
  const hideMoney = !can(actor, "revenue.view") && !!row.parsed?.paymentNote;
  if (!hideContact && !hideMoney) return row;
  const columns = Object.fromEntries(
    Object.entries(row.raw?.columns ?? {}).map(([header, value]) => {
      const field = fieldOfHeader(header);
      if (value == null) return [header, value];
      if (hideContact && field && GUEST_CONTACT_FIELDS.includes(field)) return [header, "[ẩn]"];
      if (hideMoney && field === "note") return [header, "[ẩn khoản thu]"];
      return [header, value];
    }),
  );
  const parsed = row.parsed
    ? {
        ...row.parsed,
        ...(hideContact ? { guestName: row.parsed.guestName ? "[ẩn]" : null, guestPhone: row.parsed.guestPhone ? "[ẩn]" : null } : {}),
        ...(hideMoney ? { paymentNote: "[ẩn khoản thu]", note: "[ẩn khoản thu]" } : {}),
      }
    : null;
  return { ...row, raw: { ...row.raw, columns }, parsed };
}

export async function listImportRows(actor: Actor, batchId: string, filter: RowFilter, page: { page: number; pageSize: number; offset: number }) {
  assertCan(actor, "import.preview");
  const where = ["r.batch_id = $1", "r.org_id = $2"];
  const params: unknown[] = [batchId, actor.orgId];
  if (filter.disposition && (DISPOSITIONS as readonly string[]).includes(filter.disposition)) {
    params.push(filter.disposition);
    where.push(`r.disposition = $${params.length}`);
  }
  if (filter.issue && Object.hasOwn(ISSUE_DEFS, filter.issue)) {
    params.push(JSON.stringify([{ code: filter.issue }]));
    where.push(`r.issues @> $${params.length}::jsonb`);
  }
  if (filter.sheet) {
    params.push(filter.sheet);
    where.push(`r.sheet = $${params.length}`);
  }
  const clause = where.join(" AND ");
  const rows = await query<ImportRowItem>(
    `SELECT r.id, r.sheet, r.row_number, r.raw, r.parsed, r.issues, r.disposition, r.source_key, r.booking_id
       FROM import_rows r WHERE ${clause}
      ORDER BY r.sheet = coalesce((SELECT options->>'sourceSheet' FROM import_batches WHERE id = $1), '') DESC, r.sheet, r.row_number
      LIMIT ${Number(page.pageSize)} OFFSET ${Number(page.offset)}`,
    params,
  );
  const total = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM import_rows r WHERE ${clause}`, params);
  return { items: rows.map((r) => redactRow(actor, r)), page: page.page, pageSize: page.pageSize, total: total?.n ?? 0 };
}

/** Số sản phẩm / alias hiện có — để người nhập biết tra phòng đang dựa trên gì. */
export async function importCatalogOverview(actor: Actor) {
  assertCan(actor, "import.preview");
  const row = await queryOne<{ units: number; aliases: number; is_demo: boolean }>(
    `SELECT (SELECT count(*)::int FROM units WHERE org_id = $1) AS units,
            (SELECT count(*)::int FROM unit_aliases WHERE org_id = $1) AS aliases,
            (SELECT is_demo FROM organizations WHERE id = $1) AS is_demo`,
    [actor.orgId],
  );
  return { units: row?.units ?? 0, aliases: row?.aliases ?? 0, orgIsDemo: row?.is_demo ?? false };
}
