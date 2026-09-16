import { z } from "zod";
import { withTx } from "@/lib/db";
import { AppError, conflict, notFound } from "@/lib/errors";
import { todayOps } from "@/lib/time";
import { type Actor, assertCan } from "@/modules/auth/actor";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";

/**
 * Sửa danh mục (quyền catalog.edit). Chỉ các trường vận hành: trạng thái dữ liệu, ghi chú, sức chứa, active, thời lượng dọn,
 * trạng thái listing theo kênh. KHÔNG đổi quan hệ tài nguyên (unit_resources) ở đây — đổi quan hệ làm lệch tồn đã giữ
 * (resource_claims) nên phải có migration/công cụ riêng kiểm lại mọi claim.
 *
 * Chống ghi đè: client gửi `expectedUpdatedAt` (updated_at lúc tải trang); khác ⇒ 409 stale_version.
 */

const UUID = z.string().uuid();
const dataStatus = z.enum(["confirmed", "needs_confirmation"], { message: "Trạng thái dữ liệu không hợp lệ" });
const note = z.string().trim().max(1000).nullable();
const expectedUpdatedAt = z.string().datetime({ offset: true }).optional();

export const updateUnitInput = z
  .object({
    expectedUpdatedAt,
    dataStatus: dataStatus.optional(),
    dataNote: note.optional(),
    capacity: z.number().int().min(1, "Sức chứa tối thiểu 1").max(50).optional(),
    active: z.boolean().optional(),
    cleanMinutes: z.number().int().min(10, "Thời lượng dọn tối thiểu 10 phút").max(600).nullable().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "expectedUpdatedAt"), { message: "Không có gì để cập nhật." });

export const updateListingInput = z
  .object({
    expectedUpdatedAt,
    status: z.enum(["active", "blocked_by_platform", "inactive", "unknown"], { message: "Trạng thái listing không hợp lệ" }).optional(),
    dataStatus: dataStatus.optional(),
    dataNote: note.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "expectedUpdatedAt"), { message: "Không có gì để cập nhật." });

export const updatePropertyInput = z
  .object({
    expectedUpdatedAt,
    dataStatus: dataStatus.optional(),
    dataNote: note.optional(),
    defaultCleanMinutes: z.number().int().min(10, "Thời lượng dọn tối thiểu 10 phút").max(600).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "expectedUpdatedAt"), { message: "Không có gì để cập nhật." });

function assertId(id: string, what: string) {
  // Kiểm trước khi truy vấn: uuid sai định dạng làm câu lệnh lỗi trong giao dịch (bẫy PGlite).
  if (!UUID.safeParse(id).success) throw notFound(what);
}

function assertFresh(updatedAt: Date, expected: string | undefined) {
  if (expected && new Date(updatedAt).getTime() !== new Date(expected).getTime()) {
    throw new AppError("stale_version", "Dữ liệu đã được người khác sửa sau khi bạn mở trang. Tải lại rồi sửa tiếp.", 409);
  }
}

function changed<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(after)) if (v !== undefined && before[k] !== v) diff[k] = { from: before[k], to: v };
  return diff;
}

export async function updateUnit(actor: Actor, unitId: string, raw: unknown) {
  assertCan(actor, "catalog.edit");
  assertId(unitId, "sản phẩm");
  const input = updateUnitInput.parse(raw);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; code: string; capacity: number; active: boolean; clean_minutes: number | null; data_status: string; data_note: string | null; updated_at: Date }>(
      "SELECT id, code, capacity, active, clean_minutes, data_status, data_note, updated_at FROM units WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [unitId, actor.orgId],
    );
    const unit = rows[0];
    if (!unit) throw notFound("sản phẩm");
    assertFresh(unit.updated_at, input.expectedUpdatedAt);

    let futureAllocations = 0;
    if (input.capacity !== undefined || input.active === false) {
      const today = todayOps(actor.timezone);
      const future = await tx.query<{ external_ref: string | null; start_date: string; end_date: string; guests: number | null }>(
        `SELECT b.external_ref, a.start_date, a.end_date, coalesce(a.guests, b.total_guests) AS guests
           FROM booking_allocations a JOIN bookings b ON b.id = a.booking_id AND b.booking_status <> 'cancelled'
          WHERE a.org_id = $1 AND a.unit_id = $2 AND a.status = 'active' AND a.end_date > $3
          ORDER BY a.start_date`,
        [actor.orgId, unitId, today],
      );
      futureAllocations = future.rows.length;
      if (input.capacity !== undefined && input.capacity < unit.capacity) {
        const over = future.rows.filter((r) => r.guests != null && r.guests > input.capacity!);
        if (over.length) {
          throw conflict("capacity_below_bookings", `Không giảm sức chứa ${unit.code} xuống ${input.capacity}: còn booking sắp tới có nhiều khách hơn.`, {
            issues: over.map((r) => ({ message: `${r.external_ref ?? "(không mã)"} ${r.start_date} → ${r.end_date}: ${r.guests} khách` })),
          });
        }
      }
    }

    const { rows: updated } = await tx.query<{ updated_at: Date }>(
      `UPDATE units SET
         data_status = coalesce($3, data_status),
         data_note = CASE WHEN $4::boolean THEN $5 ELSE data_note END,
         capacity = coalesce($6, capacity),
         active = coalesce($7, active),
         clean_minutes = CASE WHEN $8::boolean THEN $9::int ELSE clean_minutes END,
         updated_at = now()
       WHERE id = $1 AND org_id = $2 RETURNING updated_at`,
      [
        unitId,
        actor.orgId,
        input.dataStatus ?? null,
        input.dataNote !== undefined,
        input.dataNote || null,
        input.capacity ?? null,
        input.active ?? null,
        input.cleanMinutes !== undefined,
        input.cleanMinutes ?? null,
      ],
    );
    const diff = changed(unit as unknown as Record<string, unknown>, {
      data_status: input.dataStatus,
      data_note: input.dataNote === undefined ? undefined : input.dataNote || null,
      capacity: input.capacity,
      active: input.active,
      clean_minutes: input.cleanMinutes,
    });
    await writeAudit(tx, auditActorOf(actor), "catalog.unit_update", "unit", unitId, { code: unit.code, changes: diff });
    return {
      ok: true,
      updatedAt: updated[0].updated_at,
      changes: diff,
      warning: input.active === false && futureAllocations ? `${unit.code} còn ${futureAllocations} phân bổ sắp tới — booking đã có vẫn giữ phòng, chỉ không nhận booking mới.` : null,
    };
  });
}

export async function updateListing(actor: Actor, listingId: string, raw: unknown) {
  assertCan(actor, "catalog.edit");
  assertId(listingId, "listing");
  const input = updateListingInput.parse(raw);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; channel: string; unit_id: string; status: string; data_status: string; data_note: string | null; updated_at: Date }>(
      "SELECT id, channel, unit_id, status, data_status, data_note, updated_at FROM channel_listings WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [listingId, actor.orgId],
    );
    const listing = rows[0];
    if (!listing) throw notFound("listing");
    assertFresh(listing.updated_at, input.expectedUpdatedAt);
    const { rows: updated } = await tx.query<{ updated_at: Date }>(
      `UPDATE channel_listings SET status = coalesce($3, status), data_status = coalesce($4, data_status),
              data_note = CASE WHEN $5::boolean THEN $6 ELSE data_note END, updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING updated_at`,
      [listingId, actor.orgId, input.status ?? null, input.dataStatus ?? null, input.dataNote !== undefined, input.dataNote || null],
    );
    const diff = changed(listing as unknown as Record<string, unknown>, {
      status: input.status,
      data_status: input.dataStatus,
      data_note: input.dataNote === undefined ? undefined : input.dataNote || null,
    });
    // Trạng thái theo từng kênh: không suy ra khoá toàn sản phẩm, không đụng tồn.
    await writeAudit(tx, auditActorOf(actor), "catalog.listing_update", "channel_listing", listingId, { channel: listing.channel, unitId: listing.unit_id, changes: diff });
    return { ok: true, updatedAt: updated[0].updated_at, changes: diff };
  });
}

export async function updateProperty(actor: Actor, propertyId: string, raw: unknown) {
  assertCan(actor, "catalog.edit");
  assertId(propertyId, "nhà");
  const input = updatePropertyInput.parse(raw);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; code: string; data_status: string; data_note: string | null; default_clean_minutes: number; updated_at: Date }>(
      "SELECT id, code, data_status, data_note, default_clean_minutes, updated_at FROM properties WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [propertyId, actor.orgId],
    );
    const property = rows[0];
    if (!property) throw notFound("nhà");
    assertFresh(property.updated_at, input.expectedUpdatedAt);
    const { rows: updated } = await tx.query<{ updated_at: Date }>(
      `UPDATE properties SET data_status = coalesce($3, data_status), data_note = CASE WHEN $4::boolean THEN $5 ELSE data_note END,
              default_clean_minutes = coalesce($6, default_clean_minutes), updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING updated_at`,
      [propertyId, actor.orgId, input.dataStatus ?? null, input.dataNote !== undefined, input.dataNote || null, input.defaultCleanMinutes ?? null],
    );
    const diff = changed(property as unknown as Record<string, unknown>, {
      data_status: input.dataStatus,
      data_note: input.dataNote === undefined ? undefined : input.dataNote || null,
      default_clean_minutes: input.defaultCleanMinutes,
    });
    await writeAudit(tx, auditActorOf(actor), "catalog.property_update", "property", propertyId, { code: property.code, changes: diff });
    return { ok: true, updatedAt: updated[0].updated_at, changes: diff };
  });
}
