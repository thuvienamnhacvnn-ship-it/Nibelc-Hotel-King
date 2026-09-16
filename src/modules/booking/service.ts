import type pg from "pg";
import { type Queryable, pool, queryOne, withTx } from "@/lib/db";
import { AppError, conflict, invalid, notFound } from "@/lib/errors";
import { parseMoneyToMinor } from "@/lib/money";
import { diffDays, hhmm, now } from "@/lib/time";
import { writeAudit, auditActorOf } from "@/modules/audit/audit";
import { type Actor, assertCan, can } from "@/modules/auth/actor";
import { claimForAllocation, claimForBlock, findConflicts, lockAndCheck, releaseClaimsForAllocation } from "@/modules/inventory/inventory";
import { emit } from "@/modules/outbox/outbox";
import { setReadinessForUnit } from "@/modules/cleaning/readiness";
import { STAY_RULES } from "./rules";
import {
  type ChangeRequestPayload,
  changeRequestInput,
  createBookingInput,
  updateBookingDetailsInput,
} from "./types";

// ───────────────────────── Kiểu dữ liệu nội bộ ─────────────────────────

export interface BookingRow {
  id: string;
  org_id: string;
  source_channel: string;
  source_account: string;
  external_ref: string | null;
  guest_id: string | null;
  booking_status: string;
  stay_status: string;
  payment_status: string;
  check_in_date: string;
  check_out_date: string;
  adults: number | null;
  children: number | null;
  total_guests: number | null;
  eta_local: string | null;
  early_checkin_time: string | null;
  late_checkout_time: string | null;
  actual_check_in_at: Date | null;
  actual_check_out_at: Date | null;
  total_amount_minor: number | null;
  currency: string;
  channel_note: string | null;
  ops_note: string | null;
  version: number;
  source_version: number | null;
  source_updated_at: Date | null;
  is_demo: boolean;
}

export interface AllocationRow {
  id: string;
  booking_id: string;
  unit_id: string;
  start_date: string;
  end_date: string;
  guests: number | null;
  status: "active" | "released" | "conflict";
}

interface ChangeSource {
  actorType: "user" | "system" | "connector" | "import" | "agent";
  actorId: string | null;
  source: string;
  sourceRef?: string | null;
  reason?: string | null;
}

export function changeSourceOf(actor: Actor, source = "webapp"): ChangeSource {
  return { actorType: actor.kind, actorId: actor.userId, source };
}

// ───────────────────────── Tiện ích dùng chung ─────────────────────────

export async function lockBooking(tx: Queryable, orgId: string, bookingId: string): Promise<BookingRow> {
  const { rows } = await tx.query<BookingRow>("SELECT * FROM bookings WHERE id = $1 AND org_id = $2 FOR UPDATE", [bookingId, orgId]);
  if (!rows[0]) throw notFound("booking");
  return rows[0];
}

export async function activeAllocations(tx: Queryable, bookingId: string): Promise<AllocationRow[]> {
  const { rows } = await tx.query<AllocationRow>(
    "SELECT id, booking_id, unit_id, start_date, end_date, guests, status FROM booking_allocations WHERE booking_id = $1 AND status IN ('active','conflict') ORDER BY start_date, created_at",
    [bookingId],
  );
  return rows;
}

async function snapshot(tx: Queryable, bookingId: string) {
  const { rows } = await tx.query(
    `SELECT b.booking_status, b.stay_status, b.payment_status, b.check_in_date, b.check_out_date, b.adults, b.children,
            b.total_guests, b.eta_local, b.early_checkin_time, b.late_checkout_time, b.total_amount_minor, b.currency,
            b.channel_note, b.ops_note, b.external_ref,
            g.full_name AS guest_name,
            (SELECT coalesce(json_agg(json_build_object('unit', u.code, 'start', a.start_date, 'end', a.end_date, 'status', a.status) ORDER BY a.start_date, u.code), '[]'::json)
               FROM booking_allocations a JOIN units u ON u.id = a.unit_id
              WHERE a.booking_id = b.id AND a.status IN ('active','conflict')) AS allocations
       FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0] as Record<string, unknown>;
}

/** Tăng version, ghi lịch sử trước/sau và phát sự kiện booking.changed trong cùng giao dịch. */
export async function recordBookingChange(
  tx: Queryable,
  booking: Pick<BookingRow, "id" | "org_id" | "version">,
  changeType: string,
  before: Record<string, unknown> | null,
  src: ChangeSource,
): Promise<number> {
  const { rows } = await tx.query<{ version: number }>(
    "UPDATE bookings SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version",
    [booking.id],
  );
  const version = rows[0].version;
  const after = await snapshot(tx, booking.id);
  await tx.query(
    `INSERT INTO booking_changes (org_id, booking_id, version, change_type, before, after, actor_type, actor_id, source, source_ref, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [booking.org_id, booking.id, version, changeType, before ? JSON.stringify(before) : null, JSON.stringify(after), src.actorType, src.actorId, src.source, src.sourceRef ?? null, src.reason ?? null],
  );
  await emit(tx, {
    orgId: booking.org_id,
    topic: "booking.changed",
    aggregateType: "booking",
    aggregateId: booking.id,
    aggregateVersion: version,
    payload: { changeType, version },
    dedupeKey: `booking:${booking.id}:v${version}`,
  });
  return version;
}

interface UnitInfo {
  id: string;
  code: string;
  capacity: number;
  active: boolean;
  kind: string;
  property_id: string;
}

async function loadUnit(q: Queryable, orgId: string, unitId: string): Promise<UnitInfo> {
  const { rows } = await q.query<UnitInfo>("SELECT id, code, capacity, active, kind, property_id FROM units WHERE id = $1 AND org_id = $2", [unitId, orgId]);
  if (!rows[0]) throw notFound("căn/phòng");
  return rows[0];
}

export async function insertAllocation(
  tx: Queryable,
  orgId: string,
  bookingId: string,
  a: { unitId: string; startDate: string; endDate: string; guests: number | null },
  opts: { onConflict: "throw" | "mark" } = { onConflict: "throw" },
): Promise<AllocationRow> {
  if (a.endDate <= a.startDate) throw invalid("Khoảng ngày phân bổ không hợp lệ.");
  const unit = await loadUnit(tx, orgId, a.unitId);
  if (!unit.active) throw conflict("unit_inactive", `Sản phẩm ${unit.code} đang ngừng hoạt động.`);
  if (a.guests != null && a.guests > unit.capacity) {
    throw conflict("capacity_exceeded", `${unit.code} chứa tối đa ${unit.capacity} khách, yêu cầu ${a.guests}.`);
  }
  const { rows } = await tx.query<AllocationRow>(
    `INSERT INTO booking_allocations (org_id, booking_id, unit_id, start_date, end_date, guests)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, booking_id, unit_id, start_date, end_date, guests, status`,
    [orgId, bookingId, a.unitId, a.startDate, a.endDate, a.guests],
  );
  const allocation = rows[0];
  if (opts.onConflict === "mark") {
    const { conflicts } = await lockAndCheck(tx, orgId, allocation, [allocation.id]);
    if (conflicts.length) {
      // Nguồn ngoài đã bán: không được âm thầm bỏ booking. Lưu dạng xung đột (không giữ tồn) và mở cảnh báo.
      await tx.query("UPDATE booking_allocations SET status = 'conflict' WHERE id = $1", [allocation.id]);
      await tx.query(
        `INSERT INTO inventory_conflicts (org_id, booking_id, allocation_id, unit_id, start_date, end_date, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, bookingId, allocation.id, a.unitId, a.startDate, a.endDate, JSON.stringify({ conflicts })],
      );
      await emit(tx, {
        orgId,
        topic: "alert.inventory_conflict",
        aggregateType: "booking",
        aggregateId: bookingId,
        payload: { allocationId: allocation.id, unitCode: unit.code, startDate: a.startDate, endDate: a.endDate },
        dedupeKey: `conflict:${allocation.id}`,
      });
      return { ...allocation, status: "conflict" };
    }
  }
  await claimForAllocation(tx, orgId, allocation);
  return allocation;
}

export async function releaseAllocation(tx: Queryable, allocationId: string, replacedBy: string | null = null) {
  await releaseClaimsForAllocation(tx, allocationId);
  await tx.query("UPDATE booking_allocations SET status = 'released', released_at = now(), replaced_by = $2 WHERE id = $1", [allocationId, replacedBy]);
  await tx.query("UPDATE inventory_conflicts SET status = 'resolved', resolved_at = now(), resolution = 'allocation_released' WHERE allocation_id = $1 AND status = 'open'", [allocationId]);
}

/** Sức chứa nhỏ nhất theo từng đêm của các phân bổ đang giữ. */
async function minCapacityOverStay(tx: Queryable, bookingId: string): Promise<number> {
  const { rows } = await tx.query<{ min_capacity: number | null }>(
    `SELECT min(cap)::int AS min_capacity FROM (
       SELECT d::date AS night, sum(u.capacity) AS cap
         FROM bookings b
         CROSS JOIN generate_series(b.check_in_date, b.check_out_date - 1, interval '1 day') AS d
         JOIN booking_allocations a ON a.booking_id = b.id AND a.status IN ('active','conflict') AND a.start_date <= d::date AND a.end_date > d::date
         JOIN units u ON u.id = a.unit_id
        WHERE b.id = $1
        GROUP BY d) nights`,
    [bookingId],
  );
  return rows[0]?.min_capacity ?? 0;
}

// ───────────────────────── Tạo và sửa thông tin ─────────────────────────

export async function createBooking(actor: Actor, raw: unknown): Promise<{ id: string; version: number }> {
  assertCan(actor, "booking.create");
  const input = createBookingInput.parse(raw);
  if (diffDays(input.checkInDate, input.checkOutDate) > 366) throw invalid("Kỳ ở dài quá 366 đêm — kiểm tra lại ngày.");
  const totalMinor = input.totalAmount ? parseMoneyToMinor(input.totalAmount) : null;
  if (totalMinor != null && !can(actor, "revenue.view")) throw new AppError("forbidden", "Bạn không có quyền nhập số tiền booking.", 403);

  return withTx(async (tx) => {
    const guest = await tx.query<{ id: string }>(
      "INSERT INTO guests (org_id, full_name, email, phone, language) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [actor.orgId, input.guest.fullName, input.guest.email || null, input.guest.phone || null, input.guest.language || null],
    );
    const adults = input.adults ?? null;
    const children = input.children ?? null;
    const total = adults != null || children != null ? (adults ?? 0) + (children ?? 0) : null;
    if (input.externalRef) await assertSourceRefFree(tx, actor.orgId, input.sourceChannel, input.sourceAccount ?? "", input.externalRef, null);
    let booking: { id: string; org_id: string; version: number };
    {
      const res = await tx.query<{ id: string; org_id: string; version: number }>(
        `INSERT INTO bookings (org_id, source_channel, source_account, external_ref, guest_id, booking_status, stay_status, payment_status,
                               check_in_date, check_out_date, adults, children, total_guests, eta_local, total_amount_minor, currency,
                               channel_note, ops_note, booking_created_at, created_by, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,'confirmed','expected',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$17,NULL)
         RETURNING id, org_id, version`,
        [
          actor.orgId,
          input.sourceChannel,
          input.sourceAccount ?? "",
          input.externalRef || null,
          guest.rows[0].id,
          input.paymentStatus,
          input.checkInDate,
          input.checkOutDate,
          adults,
          children,
          total,
          input.etaLocal || null,
          totalMinor,
          input.currency.toUpperCase(),
          input.channelNote ?? null,
          input.opsNote ?? null,
          actor.userId,
        ],
      );
      booking = res.rows[0];
    }

    for (const a of input.allocations) {
      const start = a.startDate ?? input.checkInDate;
      const end = a.endDate ?? input.checkOutDate;
      if (start < input.checkInDate || end > input.checkOutDate) {
        throw invalid(`Phân bổ phòng ${start}→${end} nằm ngoài kỳ ở của booking.`);
      }
      await insertAllocation(tx, actor.orgId, booking.id, { unitId: a.unitId, startDate: start, endDate: end, guests: a.guests ?? null });
    }
    await assertNightsCovered(tx, booking.id);
    if (total != null) {
      const cap = await minCapacityOverStay(tx, booking.id);
      if (total > cap) throw conflict("capacity_exceeded", `Tổng ${total} khách vượt sức chứa ${cap} của phòng đã chọn.`);
    }

    const version = await recordBookingChange(tx, booking, "created", null, changeSourceOf(actor));
    await writeAudit(tx, auditActorOf(actor), "booking.create", "booking", booking.id, { sourceChannel: input.sourceChannel, externalRef: input.externalRef });
    return { id: booking.id, version };
  });
}

/** Kiểm tra trước thay vì chờ lỗi unique từ DB (lỗi giữa giao dịch làm hỏng kết nối PGlite). */
async function assertSourceRefFree(tx: Queryable, orgId: string, channel: string, account: string, ref: string, exceptBookingId: string | null) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7332))", [`${orgId}|${channel}|${account}|${ref}`]);
  const { rows } = await tx.query(
    "SELECT 1 FROM bookings WHERE org_id = $1 AND source_channel = $2 AND source_account = $3 AND external_ref = $4 AND ($5::uuid IS NULL OR id <> $5)",
    [orgId, channel, account, ref, exceptBookingId],
  );
  if (rows.length) throw conflict("duplicate_source_ref", "Đã có booking với cùng kênh, tài khoản và mã đặt phòng.");
}

/** Mọi đêm của kỳ ở phải có ít nhất một phòng — không để booking "treo" đêm không chỗ ở. */
async function assertNightsCovered(tx: Queryable, bookingId: string) {
  const { rows } = await tx.query<{ night: string }>(
    `SELECT d::date::text AS night FROM bookings b
       CROSS JOIN generate_series(b.check_in_date, b.check_out_date - 1, interval '1 day') AS d
      WHERE b.id = $1
        AND NOT EXISTS (SELECT 1 FROM booking_allocations a WHERE a.booking_id = b.id AND a.status IN ('active','conflict')
                          AND a.start_date <= d::date AND a.end_date > d::date)
      LIMIT 3`,
    [bookingId],
  );
  if (rows.length) throw invalid(`Đêm ${rows.map((r) => r.night).join(", ")} chưa có phòng nào được phân bổ.`);
}

export async function updateBookingDetails(actor: Actor, bookingId: string, raw: unknown) {
  assertCan(actor, "booking.edit");
  const input = updateBookingDetailsInput.parse(raw);
  if ((input.totalAmount !== undefined || input.currency !== undefined) && !can(actor, "revenue.view")) {
    throw new AppError("forbidden", "Bạn không có quyền sửa số tiền booking.", 403);
  }
  return withTx(async (tx) => {
    const booking = await lockBooking(tx, actor.orgId, bookingId);
    if (booking.version !== input.expectedVersion) {
      throw conflict("stale_version", "Booking vừa được người khác hoặc hệ thống cập nhật. Tải lại để xem bản mới nhất.", { currentVersion: booking.version });
    }
    const before = await snapshot(tx, bookingId);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.etaLocal !== undefined) set("eta_local", input.etaLocal || null);
    if (input.totalAmount !== undefined) set("total_amount_minor", input.totalAmount ? parseMoneyToMinor(input.totalAmount) : null);
    if (input.currency !== undefined) set("currency", input.currency.toUpperCase());
    if (input.paymentStatus !== undefined) set("payment_status", input.paymentStatus);
    if (input.channelNote !== undefined) set("channel_note", input.channelNote);
    if (input.opsNote !== undefined) set("ops_note", input.opsNote);
    if (input.externalRef !== undefined) set("external_ref", input.externalRef || null);
    if (input.externalRef) await assertSourceRefFree(tx, actor.orgId, booking.source_channel, booking.source_account, input.externalRef, bookingId);
    if (sets.length) {
      params.push(bookingId);
      await tx.query(`UPDATE bookings SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    }
    if (input.guest && booking.guest_id) {
      const g = input.guest;
      await tx.query(
        `UPDATE guests SET full_name = coalesce($2, full_name), email = CASE WHEN $3::boolean THEN $4 ELSE email END,
                phone = CASE WHEN $5::boolean THEN $6 ELSE phone END, language = CASE WHEN $7::boolean THEN $8 ELSE language END
          WHERE id = $1 AND org_id = $9`,
        [booking.guest_id, g.fullName ?? null, g.email !== undefined, g.email || null, g.phone !== undefined, g.phone || null, g.language !== undefined, g.language || null, actor.orgId],
      );
    }
    const version = await recordBookingChange(tx, booking, "details_updated", before, changeSourceOf(actor));
    await writeAudit(tx, auditActorOf(actor), "booking.update_details", "booking", bookingId, { fields: Object.keys(raw as object) });
    return { id: bookingId, version };
  });
}

// ───────────────────────── Yêu cầu thay đổi ─────────────────────────

export interface ChangeCheck {
  ok: boolean;
  issues: { code: string; message: string; details?: unknown }[];
  checkedAt: string;
}

async function evaluateChange(q: Queryable, orgId: string, booking: BookingRow, payload: ChangeRequestPayload): Promise<ChangeCheck> {
  const issues: ChangeCheck["issues"] = [];
  const allocations = await activeAllocations(q, booking.id);
  const ownIds = allocations.map((a) => a.id);
  if (booking.booking_status === "cancelled" && payload.kind !== "cancel") {
    issues.push({ code: "booking_cancelled", message: "Booking đã hủy." });
  }
  switch (payload.kind) {
    case "dates": {
      if (payload.checkOutDate <= payload.checkInDate) issues.push({ code: "invalid_dates", message: "Ngày trả phải sau ngày nhận." });
      if (hasMidStayMove(allocations, booking)) {
        issues.push({ code: "has_room_move", message: "Booking có đổi phòng giữa kỳ — đổi ngày từng đoạn bằng thao tác đổi phòng." });
      }
      if (booking.stay_status === "checked_in" && payload.checkInDate !== booking.check_in_date) {
        issues.push({ code: "already_checked_in", message: "Khách đã nhận phòng — không đổi được ngày nhận." });
      }
      for (const a of allocations) {
        const conflicts = await findConflicts(q, orgId, a.unit_id, payload.checkInDate, payload.checkOutDate, ownIds);
        if (conflicts.length) issues.push({ code: "inventory_conflict", message: "Khoảng ngày mới trùng booking/chặn tồn khác.", details: { conflicts } });
      }
      break;
    }
    case "move_unit": {
      const a = allocations.find((x) => x.id === payload.allocationId);
      if (!a) {
        issues.push({ code: "allocation_not_found", message: "Không tìm thấy phân bổ phòng đang giữ của booking." });
        break;
      }
      const eff = payload.effectiveDate ?? a.start_date;
      if (eff < a.start_date || eff >= a.end_date) issues.push({ code: "invalid_effective_date", message: "Ngày chuyển phải nằm trong đoạn đang ở." });
      if (payload.toUnitId === a.unit_id) issues.push({ code: "same_unit", message: "Phòng mới trùng phòng hiện tại." });
      const target = await q.query<{ capacity: number; active: boolean }>("SELECT capacity, active FROM units WHERE id = $1 AND org_id = $2", [payload.toUnitId, orgId]);
      if (!target.rows[0]) issues.push({ code: "unit_not_found", message: "Không tìm thấy phòng mới." });
      else {
        if (!target.rows[0].active) issues.push({ code: "unit_inactive", message: "Phòng mới đang ngừng hoạt động." });
        if (a.guests != null && a.guests > target.rows[0].capacity) issues.push({ code: "capacity_exceeded", message: `Phòng mới chứa tối đa ${target.rows[0].capacity} khách.` });
      }
      const conflicts = await findConflicts(q, orgId, payload.toUnitId, eff, a.end_date, ownIds);
      if (conflicts.length) issues.push({ code: "inventory_conflict", message: "Phòng mới đã có booking/chặn tồn trong khoảng này.", details: { conflicts } });
      break;
    }
    case "guests": {
      const total = payload.adults + payload.children;
      const cap = await minCapacityOverStay(q, booking.id);
      if (total > cap) issues.push({ code: "capacity_exceeded", message: `Tổng ${total} khách vượt sức chứa ${cap}.` });
      break;
    }
    case "cancel": {
      if (booking.booking_status === "cancelled") issues.push({ code: "already_cancelled", message: "Booking đã hủy trước đó." });
      if (booking.stay_status === "checked_in") issues.push({ code: "already_checked_in", message: "Khách đang ở — dùng đổi ngày trả phòng thay vì hủy." });
      break;
    }
    case "late_checkout": {
      const prop = await propertyTimesForBooking(q, booking.id);
      if (payload.time <= prop.check_out_at) issues.push({ code: "not_late", message: `Giờ trả chuẩn là ${prop.check_out_at}.` });
      if (payload.time > STAY_RULES.latestLateCheckOut) issues.push({ code: "too_late", message: `Trả muộn tối đa ${STAY_RULES.latestLateCheckOut}.` });
      const arrivals = await sameDayNeighbours(q, orgId, booking.id, booking.check_out_date, "arrival");
      if (arrivals.length) issues.push({ code: "next_booking_same_day", message: "Có khách nhận cùng phòng trong ngày trả — cần Dịu/Thảo xác nhận trước khi hứa với khách.", details: { arrivals } });
      break;
    }
    case "early_checkin": {
      const prop = await propertyTimesForBooking(q, booking.id);
      if (payload.time >= prop.check_in_from) issues.push({ code: "not_early", message: `Giờ nhận chuẩn là ${prop.check_in_from}.` });
      if (payload.time < STAY_RULES.earliestEarlyCheckIn) issues.push({ code: "too_early", message: `Nhận sớm từ ${STAY_RULES.earliestEarlyCheckIn}.` });
      const departures = await sameDayNeighbours(q, orgId, booking.id, booking.check_in_date, "departure");
      if (departures.length) issues.push({ code: "previous_booking_same_day", message: "Phòng có khách trả cùng ngày — phụ thuộc tiến độ dọn, cần Thảo xác nhận.", details: { departures } });
      break;
    }
  }
  return { ok: issues.length === 0, issues, checkedAt: now().toISOString() };
}

function hasMidStayMove(allocations: AllocationRow[], booking: BookingRow): boolean {
  return allocations.some((a) => a.start_date !== booking.check_in_date || a.end_date !== booking.check_out_date);
}

async function propertyTimesForBooking(q: Queryable, bookingId: string) {
  const { rows } = await q.query<{ check_in_from: string; check_out_at: string }>(
    `SELECT p.check_in_from::text, p.check_out_at::text FROM booking_allocations a JOIN units u ON u.id = a.unit_id JOIN properties p ON p.id = u.property_id
      WHERE a.booking_id = $1 ORDER BY a.status = 'active' DESC LIMIT 1`,
    [bookingId],
  );
  return { check_in_from: hhmm(rows[0]?.check_in_from ?? "15:00"), check_out_at: hhmm(rows[0]?.check_out_at ?? "10:00") };
}

/** Booking khác nhận (arrival) hoặc trả (departure) trên cùng tài nguyên vào một ngày. */
async function sameDayNeighbours(q: Queryable, orgId: string, bookingId: string, date: string, kind: "arrival" | "departure") {
  const { rows } = await q.query<{ booking_id: string; external_ref: string | null; unit_code: string }>(
    `SELECT DISTINCT b2.id AS booking_id, b2.external_ref, u2.code AS unit_code
       FROM booking_allocations a
       JOIN unit_resources ur ON ur.unit_id = a.unit_id
       JOIN resource_claims c ON c.resource_id = ur.resource_id AND c.active AND c.org_id = $1
       JOIN booking_allocations a2 ON a2.id = c.allocation_id AND a2.booking_id <> a.booking_id
       JOIN bookings b2 ON b2.id = a2.booking_id
       JOIN units u2 ON u2.id = a2.unit_id
      WHERE a.booking_id = $2 AND a.status = 'active'
        AND ${kind === "arrival" ? "lower(c.stay) = $3::date" : "upper(c.stay) = $3::date"}`,
    [orgId, bookingId, date],
  );
  return rows;
}

export async function requestChange(
  actor: Actor,
  bookingId: string,
  raw: unknown,
  opts: { source?: "staff" | "guest_message" | "connector" | "agent"; note?: string | null; applyNow?: boolean } = {},
) {
  assertCan(actor, "booking.request_change");
  const payload = changeRequestInput.parse(raw);
  if (opts.applyNow) assertCan(actor, "booking.approve_change", "Bạn chỉ được tạo yêu cầu; người có quyền duyệt sẽ áp dụng.");
  const cr = await withTx(async (tx) => {
    const booking = await lockBooking(tx, actor.orgId, bookingId);
    const check = await evaluateChange(tx, actor.orgId, booking, payload);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO change_requests (org_id, booking_id, booking_version, kind, payload, source, note, check_result, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [actor.orgId, bookingId, booking.version, payload.kind, JSON.stringify(payload), opts.source ?? "staff", opts.note ?? null, JSON.stringify(check), actor.userId],
    );
    await emit(tx, {
      orgId: actor.orgId,
      topic: "change_request.created",
      aggregateType: "change_request",
      aggregateId: rows[0].id,
      payload: { bookingId, kind: payload.kind, ok: check.ok },
      dedupeKey: `cr:${rows[0].id}:created`,
    });
    await writeAudit(tx, auditActorOf(actor), "change_request.create", "booking", bookingId, { changeRequestId: rows[0].id, kind: payload.kind });
    return { id: rows[0].id, check };
  });
  if (opts.applyNow && cr.check.ok) {
    const applied = await applyChangeRequest(actor, cr.id);
    return { ...cr, applied: true, version: applied.version };
  }
  return { ...cr, applied: false };
}

export async function applyChangeRequest(actor: Actor, changeRequestId: string, decisionNote?: string | null) {
  assertCan(actor, "booking.approve_change");
  try {
    return await withTx(async (tx) => {
      const { rows } = await tx.query<{ id: string; booking_id: string; booking_version: number; status: string; payload: ChangeRequestPayload; requested_by: string | null }>(
        "SELECT id, booking_id, booking_version, status, payload, requested_by FROM change_requests WHERE id = $1 AND org_id = $2 FOR UPDATE",
        [changeRequestId, actor.orgId],
      );
      const cr = rows[0];
      if (!cr) throw notFound("yêu cầu thay đổi");
      if (cr.status !== "pending") throw conflict("change_request_closed", "Yêu cầu này đã được xử lý.");
      const booking = await lockBooking(tx, actor.orgId, cr.booking_id);
      if (booking.version !== cr.booking_version) {
        await tx.query("UPDATE change_requests SET status = 'superseded', decided_at = now(), decided_by = $2, decision_note = $3 WHERE id = $1", [
          cr.id,
          actor.userId,
          `Booking đã đổi từ phiên bản ${cr.booking_version} lên ${booking.version} trước khi duyệt.`,
        ]);
        return { superseded: true as const, version: booking.version };
      }
      const check = await evaluateChange(tx, actor.orgId, booking, cr.payload);
      if (!check.ok) {
        throw conflict(check.issues[0].code, check.issues[0].message, { issues: check.issues });
      }
      const before = await snapshot(tx, booking.id);
      await applyPayload(tx, actor, booking, cr.payload);
      const version = await recordBookingChange(tx, booking, `change_request:${cr.payload.kind}`, before, {
        ...changeSourceOf(actor),
        sourceRef: cr.id,
        reason: decisionNote ?? null,
      });
      await tx.query(
        "UPDATE change_requests SET status = 'applied', decided_by = $2, decided_at = now(), decision_note = $3, check_result = $4 WHERE id = $1",
        [cr.id, actor.userId, decisionNote ?? null, JSON.stringify(check)],
      );
      await writeAudit(tx, auditActorOf(actor), "change_request.apply", "booking", booking.id, { changeRequestId: cr.id, kind: cr.payload.kind });
      return { superseded: false as const, version };
    });
  } catch (error) {
    // Lưu kết quả kiểm tra mới nhất để người duyệt thấy vì sao chưa áp dụng được.
    if (error instanceof AppError && error.status === 409) {
      await pool()
        .query("UPDATE change_requests SET check_result = $2 WHERE id = $1 AND org_id = $3 AND status = 'pending'", [
          changeRequestId,
          JSON.stringify({ ok: false, issues: (error.details as { issues?: unknown })?.issues ?? [{ code: error.code, message: error.message, details: error.details }], checkedAt: now().toISOString() }),
          actor.orgId,
        ])
        .catch(() => undefined);
    }
    throw error;
  }
}

async function applyPayload(tx: pg.PoolClient, actor: Actor, booking: BookingRow, payload: ChangeRequestPayload) {
  const allocations = await activeAllocations(tx, booking.id);
  switch (payload.kind) {
    case "dates": {
      for (const a of allocations) await releaseAllocation(tx, a.id);
      await tx.query("UPDATE bookings SET check_in_date = $2, check_out_date = $3 WHERE id = $1", [booking.id, payload.checkInDate, payload.checkOutDate]);
      for (const a of allocations) {
        const created = await insertAllocation(tx, actor.orgId, booking.id, { unitId: a.unit_id, startDate: payload.checkInDate, endDate: payload.checkOutDate, guests: a.guests });
        await tx.query("UPDATE booking_allocations SET replaced_by = $2 WHERE id = $1", [a.id, created.id]);
      }
      return;
    }
    case "move_unit": {
      const a = allocations.find((x) => x.id === payload.allocationId)!;
      const eff = payload.effectiveDate ?? a.start_date;
      await releaseAllocation(tx, a.id);
      if (eff > a.start_date) {
        await insertAllocation(tx, actor.orgId, booking.id, { unitId: a.unit_id, startDate: a.start_date, endDate: eff, guests: a.guests });
      }
      const moved = await insertAllocation(tx, actor.orgId, booking.id, { unitId: payload.toUnitId, startDate: eff, endDate: a.end_date, guests: a.guests });
      await tx.query("UPDATE booking_allocations SET replaced_by = $2 WHERE id = $1", [a.id, moved.id]);
      return;
    }
    case "guests": {
      await tx.query("UPDATE bookings SET adults = $2, children = $3, total_guests = $4 WHERE id = $1", [booking.id, payload.adults, payload.children, payload.adults + payload.children]);
      return;
    }
    case "cancel": {
      for (const a of allocations) await releaseAllocation(tx, a.id);
      await tx.query("UPDATE bookings SET booking_status = 'cancelled', ops_note = concat_ws(E'\\n', ops_note, $2::text) WHERE id = $1", [booking.id, `Hủy: ${payload.reason}`]);
      return;
    }
    case "late_checkout": {
      await tx.query("UPDATE bookings SET late_checkout_time = $2 WHERE id = $1", [booking.id, payload.time]);
      return;
    }
    case "early_checkin": {
      await tx.query("UPDATE bookings SET early_checkin_time = $2 WHERE id = $1", [booking.id, payload.time]);
      return;
    }
  }
}

export async function rejectChangeRequest(actor: Actor, changeRequestId: string, note: string) {
  assertCan(actor, "booking.approve_change");
  if (!note?.trim()) throw invalid("Cần ghi lý do từ chối.");
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ booking_id: string }>(
      "UPDATE change_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1 AND org_id = $4 AND status = 'pending' RETURNING booking_id",
      [changeRequestId, actor.userId, note.trim(), actor.orgId],
    );
    if (!rows[0]) throw conflict("change_request_closed", "Yêu cầu không còn ở trạng thái chờ.");
    await writeAudit(tx, auditActorOf(actor), "change_request.reject", "booking", rows[0].booking_id, { changeRequestId, note });
    return { ok: true };
  });
}

// ───────────────────────── Thực tế lưu trú ─────────────────────────

const STAY_TRANSITIONS: Record<string, string[]> = {
  expected: ["checked_in", "no_show"],
  checked_in: ["checked_out"],
  no_show: ["expected"],
  unknown: ["checked_in", "checked_out", "no_show"],
  checked_out: [],
};

export async function setStayStatus(actor: Actor, bookingId: string, input: { status: string; expectedVersion: number; at?: string | null }) {
  assertCan(actor, "booking.stay_status");
  return withTx(async (tx) => {
    const booking = await lockBooking(tx, actor.orgId, bookingId);
    if (booking.version !== input.expectedVersion) throw conflict("stale_version", "Booking vừa được cập nhật. Tải lại trang.", { currentVersion: booking.version });
    if (booking.booking_status === "cancelled") throw conflict("booking_cancelled", "Booking đã hủy.");
    if (!STAY_TRANSITIONS[booking.stay_status]?.includes(input.status)) {
      throw conflict("invalid_transition", `Không chuyển được từ "${booking.stay_status}" sang "${input.status}".`);
    }
    const at = input.at ? new Date(input.at) : now();
    if (Number.isNaN(at.getTime())) throw invalid("Thời điểm không hợp lệ.");
    const before = await snapshot(tx, bookingId);
    const allocations = (await activeAllocations(tx, bookingId)).filter((a) => a.status === "active");
    if (input.status === "checked_in") {
      await tx.query("UPDATE bookings SET stay_status = 'checked_in', actual_check_in_at = $2 WHERE id = $1", [bookingId, at]);
      const first = allocations.filter((a) => a.start_date === booking.check_in_date);
      for (const a of first) await setReadinessForUnit(tx, actor.orgId, a.unit_id, "occupied", { userId: actor.userId, note: "Khách nhận phòng" });
    } else if (input.status === "checked_out") {
      await tx.query("UPDATE bookings SET stay_status = 'checked_out', actual_check_out_at = $2 WHERE id = $1", [bookingId, at]);
      const last = allocations.filter((a) => a.end_date === booking.check_out_date);
      for (const a of last) await setReadinessForUnit(tx, actor.orgId, a.unit_id, "vacated_dirty", { userId: actor.userId, note: "Khách đã trả phòng" });
    } else if (input.status === "no_show") {
      await tx.query("UPDATE bookings SET stay_status = 'no_show' WHERE id = $1", [bookingId]);
    } else {
      await tx.query("UPDATE bookings SET stay_status = $2 WHERE id = $1", [bookingId, input.status]);
    }
    const version = await recordBookingChange(tx, booking, `stay:${input.status}`, before, changeSourceOf(actor));
    await writeAudit(tx, auditActorOf(actor), "booking.stay_status", "booking", bookingId, { status: input.status, at: at.toISOString() });
    return { id: bookingId, version };
  });
}

// ───────────────────────── Chặn tồn thủ công ─────────────────────────

export async function createInventoryBlock(actor: Actor, input: { unitId: string; startDate: string; endDate: string; reason: string }) {
  assertCan(actor, "inventory.block");
  if (!input.reason?.trim()) throw invalid("Cần lý do chặn.");
  if (input.endDate <= input.startDate) throw invalid("Ngày kết thúc phải sau ngày bắt đầu.");
  return withTx(async (tx) => {
    await loadUnit(tx, actor.orgId, input.unitId);
    const { rows } = await tx.query<{ id: string; unit_id: string; start_date: string; end_date: string }>(
      "INSERT INTO inventory_blocks (org_id, unit_id, start_date, end_date, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, unit_id, start_date, end_date",
      [actor.orgId, input.unitId, input.startDate, input.endDate, input.reason.trim(), actor.userId],
    );
    await claimForBlock(tx, actor.orgId, rows[0]);
    await writeAudit(tx, auditActorOf(actor), "inventory.block", "unit", input.unitId, input);
    return rows[0];
  });
}

export async function releaseInventoryBlock(actor: Actor, blockId: string) {
  assertCan(actor, "inventory.block");
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ unit_id: string }>(
      "UPDATE inventory_blocks SET active = false, released_at = now() WHERE id = $1 AND org_id = $2 AND active RETURNING unit_id",
      [blockId, actor.orgId],
    );
    if (!rows[0]) throw notFound("chặn tồn");
    await tx.query("UPDATE resource_claims SET active = false WHERE block_id = $1", [blockId]);
    await writeAudit(tx, auditActorOf(actor), "inventory.unblock", "unit", rows[0].unit_id, { blockId });
    return { ok: true };
  });
}

export async function resolveConflict(actor: Actor, conflictId: string, resolution: string) {
  assertCan(actor, "conflict.resolve");
  if (!resolution?.trim()) throw invalid("Cần ghi cách đã xử lý.");
  const row = await queryOne<{ booking_id: string }>(
    "UPDATE inventory_conflicts SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1 AND org_id = $4 AND status = 'open' RETURNING booking_id",
    [conflictId, actor.userId, resolution.trim(), actor.orgId],
  );
  if (!row) throw notFound("xung đột đang mở");
  await writeAudit(null, auditActorOf(actor), "conflict.resolve", "booking", row.booking_id, { conflictId, resolution });
  return { ok: true };
}

