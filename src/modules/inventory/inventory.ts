import type { Queryable } from "@/lib/db";
import { conflict } from "@/lib/errors";

/**
 * Tồn phòng dựa trên tài nguyên. Nguyên căn chiếm mọi phòng; phòng lẻ chiếm phòng của nó.
 * => đặt phòng lẻ chặn nguyên căn nhưng không chặn phòng lẻ khác.
 *
 * Trình tự giữ chỗ trong một giao dịch:
 *   1. Khoá tư vấn (advisory lock) từng tài nguyên theo thứ tự cố định — các giao dịch tranh cùng phòng phải xếp hàng.
 *   2. Kiểm tra chiếm dụng hiện có.
 *   3. Ghi claim. Ràng buộc EXCLUDE trong DB là chốt cuối: nếu có đường ghi nào bỏ qua bước 1–2,
 *      DB vẫn từ chối và cả giao dịch bị huỷ.
 */

export interface ClaimConflict {
  resource_code: string;
  resource_name: string;
  start_date: string;
  end_date: string;
  booking_id: string | null;
  booking_ref: string | null;
  source_channel: string | null;
  unit_code: string | null;
  block_id: string | null;
  block_reason: string | null;
}

export async function resourceIdsForUnit(q: Queryable, orgId: string, unitId: string): Promise<string[]> {
  const { rows } = await q.query<{ resource_id: string }>(
    "SELECT ur.resource_id FROM unit_resources ur JOIN units u ON u.id = ur.unit_id WHERE ur.unit_id = $1 AND u.org_id = $2 ORDER BY ur.resource_id",
    [unitId, orgId],
  );
  return rows.map((r) => r.resource_id);
}

/** Khoá theo tài nguyên đến hết giao dịch. Sắp xếp để hai giao dịch không khoá chéo nhau. */
export async function lockResources(tx: Queryable, resourceIds: string[]) {
  for (const id of [...resourceIds].sort()) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7331))", [id]);
  }
}

/** Những gì đang chiếm tài nguyên của unit trong khoảng [start, end). */
export async function findConflicts(
  q: Queryable,
  orgId: string,
  unitId: string,
  start: string,
  end: string,
  ignoreAllocationIds: string[] = [],
): Promise<ClaimConflict[]> {
  const { rows } = await q.query<ClaimConflict>(
    `SELECT r.code AS resource_code, r.name AS resource_name,
            lower(c.stay)::text AS start_date, upper(c.stay)::text AS end_date,
            b.id AS booking_id, b.external_ref AS booking_ref, b.source_channel, u.code AS unit_code,
            ib.id AS block_id, ib.reason AS block_reason
       FROM resource_claims c
       JOIN resources r ON r.id = c.resource_id
       LEFT JOIN booking_allocations a ON a.id = c.allocation_id
       LEFT JOIN bookings b ON b.id = a.booking_id
       LEFT JOIN units u ON u.id = a.unit_id
       LEFT JOIN inventory_blocks ib ON ib.id = c.block_id
      WHERE c.org_id = $1 AND c.active
        AND c.resource_id IN (SELECT resource_id FROM unit_resources WHERE unit_id = $2)
        AND c.stay && daterange($3::date, $4::date)
        AND (c.allocation_id IS NULL OR NOT (c.allocation_id = ANY($5::uuid[])))
      ORDER BY lower(c.stay)`,
    [orgId, unitId, start, end, ignoreAllocationIds],
  );
  return rows;
}

interface Span {
  unit_id: string;
  start_date: string;
  end_date: string;
}

/** Khoá + kiểm tra. Trả danh sách xung đột (rỗng = còn chỗ). Tài nguyên vẫn bị khoá tới cuối giao dịch. */
export async function lockAndCheck(tx: Queryable, orgId: string, span: Span, ignoreAllocationIds: string[] = []) {
  const resourceIds = await resourceIdsForUnit(tx, orgId, span.unit_id);
  if (resourceIds.length === 0) {
    throw conflict("unit_without_resources", "Sản phẩm chưa khai báo tài nguyên phòng nên không thể giữ tồn. Cập nhật danh mục trước.");
  }
  await lockResources(tx, resourceIds);
  const conflicts = await findConflicts(tx, orgId, span.unit_id, span.start_date, span.end_date, ignoreAllocationIds);
  return { resourceIds, conflicts };
}

/** Chiếm tài nguyên cho một phân bổ. Hết chỗ ⇒ ném 409 `inventory_conflict` kèm chi tiết. */
export async function claimForAllocation(tx: Queryable, orgId: string, allocation: Span & { id: string }) {
  const { resourceIds, conflicts } = await lockAndCheck(tx, orgId, allocation, [allocation.id]);
  if (conflicts.length) throw conflict("inventory_conflict", "Khoảng ngày này đã có booking hoặc chặn tồn trên cùng phòng.", { conflicts });
  await tx.query(
    `INSERT INTO resource_claims (org_id, resource_id, allocation_id, stay)
     SELECT $1, rid, $2, daterange($3::date, $4::date) FROM unnest($5::uuid[]) AS rid`,
    [orgId, allocation.id, allocation.start_date, allocation.end_date, resourceIds],
  );
}

export async function releaseClaimsForAllocation(tx: Queryable, allocationId: string) {
  await tx.query("UPDATE resource_claims SET active = false WHERE allocation_id = $1 AND active", [allocationId]);
}

export async function claimForBlock(tx: Queryable, orgId: string, block: Span & { id: string }) {
  const { resourceIds, conflicts } = await lockAndCheck(tx, orgId, block);
  if (conflicts.length) throw conflict("inventory_conflict", "Không chặn được: khoảng ngày đang có booking.", { conflicts });
  await tx.query(
    `INSERT INTO resource_claims (org_id, resource_id, block_id, stay)
     SELECT $1, rid, $2, daterange($3::date, $4::date) FROM unnest($5::uuid[]) AS rid`,
    [orgId, block.id, block.start_date, block.end_date, resourceIds],
  );
}
