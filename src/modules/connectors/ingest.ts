import { z } from "zod";
import { type Queryable, withTx } from "@/lib/db";
import { AppError, invalid, notFound } from "@/lib/errors";
import { isValidDate, now } from "@/lib/time";
import {
  type BookingRow,
  activeAllocations,
  insertAllocation,
  lockBooking,
  recordBookingChange,
  releaseAllocation,
} from "@/modules/booking/service";
import { writeAudit } from "@/modules/audit/audit";

/**
 * Trợ lý 1 — nhận sự kiện booking từ connector.
 * Nhận → lưu bền (inbound_events, chống trùng) → nhận diện booking + phiên bản → kiểm tra → cập nhật trong giao dịch
 * → ghi lịch sử → outbox cho Trợ lý 2/3.
 *   - Sự kiện gửi lại: không cập nhật lần hai.
 *   - Sự kiện cũ hơn trạng thái đã có: không ghi đè (stale).
 *   - Nguồn không có phiên bản và không phân định được thứ tự: needs_reconcile — phải đối soát lại nguồn.
 *   - Kênh đã bán nhưng tồn đã bị chiếm: vẫn lưu booking, đánh dấu xung đột và báo người xử lý.
 * Thay đổi do chính kênh bán xác nhận (OTA sửa ngày/hủy) được áp dụng; yêu cầu từ khách thì đi qua change_requests.
 */

const dateStr = z.string().refine(isValidDate, "Ngày không hợp lệ");

export const inboundBookingEvent = z.object({
  externalEventId: z.string().min(1).max(200),
  type: z.enum(["booking.upsert", "booking.cancelled"]),
  externalRef: z.string().min(1).max(100),
  sourceAccount: z.string().max(100).default(""),
  /** Số phiên bản tăng dần của nguồn nếu có (PMS/API). */
  sourceVersion: z.number().int().nonnegative().optional().nullable(),
  /** Thời điểm nguồn phát sinh thay đổi — dùng đo độ trễ và phân định thứ tự khi không có phiên bản. */
  occurredAt: z.string().datetime({ offset: true }).optional().nullable(),
  booking: z
    .object({
      listingExternalId: z.string().optional().nullable(),
      unitCode: z.string().optional().nullable(),
      checkInDate: dateStr,
      checkOutDate: dateStr,
      guestName: z.string().max(200).optional().nullable(),
      adults: z.number().int().min(0).optional().nullable(),
      children: z.number().int().min(0).optional().nullable(),
      totalAmountMinor: z.number().int().nonnegative().optional().nullable(),
      currency: z.string().length(3).optional().nullable(),
    })
    .optional()
    .nullable(),
});
export type InboundBookingEvent = z.infer<typeof inboundBookingEvent>;

export interface IngestResult {
  status: "applied" | "duplicate" | "stale" | "needs_reconcile" | "conflict" | "failed";
  inboundEventId: string | null;
  bookingId: string | null;
  message?: string;
}

interface ConnectorRow {
  id: string;
  org_id: string;
  channel: string;
  status: string;
  paused: boolean;
}

export async function ingestBookingEvent(orgId: string, connectorId: string, raw: unknown): Promise<IngestResult> {
  const event = inboundBookingEvent.parse(raw);
  const connector = await withTx(async (tx) => {
    const { rows } = await tx.query<ConnectorRow>("SELECT id, org_id, channel, status, paused FROM connector_accounts WHERE id = $1 AND org_id = $2", [connectorId, orgId]);
    return rows[0];
  });
  if (!connector) throw notFound("connector");
  if (connector.paused) throw new AppError("connector_paused", "Connector đang tạm dừng.", 409);

  try {
    const result = await withTx(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO inbound_events (org_id, connector_id, external_event_id, external_ref, event_type, source_version, source_occurred_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (connector_id, external_event_id) DO UPDATE
           SET status = 'received', payload = EXCLUDED.payload, received_at = now(), result = NULL, processed_at = NULL
           WHERE inbound_events.status = 'failed'   -- lần trước lỗi thì được xử lý lại; đã áp dụng thì là gửi lặp
         RETURNING id`,
        [orgId, connectorId, event.externalEventId, event.externalRef, event.type, event.sourceVersion ?? null, event.occurredAt ?? null, JSON.stringify(event)],
      );
      if (!inserted.rows[0]) {
        const prior = await tx.query<{ id: string; booking_id: string | null }>(
          "SELECT id, booking_id FROM inbound_events WHERE connector_id = $1 AND external_event_id = $2",
          [connectorId, event.externalEventId],
        );
        return { status: "duplicate", inboundEventId: prior.rows[0]?.id ?? null, bookingId: prior.rows[0]?.booking_id ?? null } satisfies IngestResult;
      }
      const inboundId = inserted.rows[0].id;
      const outcome = await applyEvent(tx, connector, event);
      await tx.query("UPDATE inbound_events SET status = $2, booking_id = $3, result = $4, processed_at = clock_timestamp() WHERE id = $1", [
        inboundId,
        outcome.status,
        outcome.bookingId,
        JSON.stringify({ message: outcome.message ?? null }),
      ]);
      return { ...outcome, inboundEventId: inboundId };
    });
    await markConnector(connectorId, true, null);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markConnector(connectorId, false, message);
    // Lưu lại sự kiện hỏng để đối soát — giao dịch chính đã rollback.
    await withTx(async (tx) => {
      await tx.query(
        `INSERT INTO inbound_events (org_id, connector_id, external_event_id, external_ref, event_type, payload, status, result, processed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'failed',$7,now()) ON CONFLICT (connector_id, external_event_id) DO NOTHING`,
        [orgId, connectorId, event.externalEventId, event.externalRef, event.type, JSON.stringify(event), JSON.stringify({ message })],
      );
    });
    return { status: "failed", inboundEventId: null, bookingId: null, message };
  }
}

async function markConnector(connectorId: string, ok: boolean, error: string | null) {
  await withTx(async (tx) => {
    await tx.query(
      ok
        ? "UPDATE connector_accounts SET last_attempt_at = now(), last_success_at = now(), last_error = NULL, updated_at = now() WHERE id = $1"
        : "UPDATE connector_accounts SET last_attempt_at = now(), last_error = $2, updated_at = now() WHERE id = $1",
      ok ? [connectorId] : [connectorId, error?.slice(0, 500)],
    );
  });
}

async function resolveUnit(tx: Queryable, orgId: string, channel: string, b: NonNullable<InboundBookingEvent["booking"]>): Promise<string> {
  if (b.listingExternalId) {
    const { rows } = await tx.query<{ unit_id: string }>(
      "SELECT unit_id FROM channel_listings WHERE org_id = $1 AND channel = $2 AND (external_listing_id = $3 OR external_room_id = $3) LIMIT 2",
      [orgId, channel, b.listingExternalId],
    );
    if (rows.length === 1) return rows[0].unit_id;
    if (rows.length > 1) throw invalid(`Mã listing ${b.listingExternalId} ứng với nhiều sản phẩm — cần sửa mapping.`);
  }
  if (b.unitCode) {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM units WHERE org_id = $1 AND code = $2", [orgId, b.unitCode]);
    if (rows[0]) return rows[0].id;
  }
  throw invalid("Không ánh xạ được listing của sự kiện sang mã phòng chuẩn — cần bổ sung mapping kênh.");
}

async function applyEvent(tx: Queryable, connector: ConnectorRow, event: InboundBookingEvent): Promise<Omit<IngestResult, "inboundEventId">> {
  const orgId = connector.org_id;
  const channel = connector.channel;
  const existing = await tx.query<BookingRow>(
    "SELECT * FROM bookings WHERE org_id = $1 AND source_channel = $2 AND source_account = $3 AND external_ref = $4 FOR UPDATE",
    [orgId, channel, event.sourceAccount ?? "", event.externalRef],
  );
  let booking = existing.rows[0] ?? null;
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
  const src = { actorType: "connector" as const, actorId: null, source: `connector:${channel}`, sourceRef: event.externalEventId };
  const actorForAudit = { orgId, actorType: "connector", actorId: null };

  // Phân định thứ tự
  if (booking) {
    if (event.sourceVersion != null && booking.source_version != null) {
      if (event.sourceVersion <= booking.source_version) {
        return { status: "stale", bookingId: booking.id, message: `Phiên bản nguồn ${event.sourceVersion} không mới hơn ${booking.source_version}.` };
      }
    } else if (occurredAt && booking.source_updated_at) {
      if (occurredAt.getTime() < new Date(booking.source_updated_at).getTime()) {
        return { status: "stale", bookingId: booking.id, message: "Sự kiện phát sinh trước trạng thái đang lưu." };
      }
      if (occurredAt.getTime() === new Date(booking.source_updated_at).getTime()) {
        return { status: "needs_reconcile", bookingId: booking.id, message: "Hai sự kiện cùng thời điểm, không có phiên bản — cần đối soát lại nguồn." };
      }
    } else {
      return { status: "needs_reconcile", bookingId: booking.id, message: "Nguồn không cung cấp phiên bản hay thời điểm — không ghi đè, cần đối soát lại nguồn." };
    }
  }

  if (event.type === "booking.cancelled") {
    if (!booking) return { status: "needs_reconcile", bookingId: null, message: "Nhận sự kiện hủy cho booking chưa có trong hệ thống." };
    booking = await lockBooking(tx, orgId, booking.id);
    if (booking.booking_status === "cancelled") return { status: "applied", bookingId: booking.id, message: "Booking đã ở trạng thái hủy." };
    for (const a of await activeAllocations(tx, booking.id)) await releaseAllocation(tx, a.id);
    await tx.query(
      "UPDATE bookings SET booking_status = 'cancelled', source_version = coalesce($2, source_version), source_updated_at = coalesce($3, source_updated_at), last_synced_at = now() WHERE id = $1",
      [booking.id, event.sourceVersion ?? null, occurredAt],
    );
    await recordBookingChange(tx, booking, "channel_cancelled", null, src);
    await writeAudit(tx, actorForAudit, "connector.booking_cancelled", "booking", booking.id, { externalRef: event.externalRef });
    return { status: "applied", bookingId: booking.id };
  }

  const b = event.booking;
  if (!b) throw invalid("Sự kiện booking.upsert thiếu dữ liệu booking.");
  if (b.checkOutDate <= b.checkInDate) throw invalid("Ngày trả phải sau ngày nhận.");
  const unitId = await resolveUnit(tx, orgId, channel, b);
  const total = b.adults != null || b.children != null ? (b.adults ?? 0) + (b.children ?? 0) : null;

  if (!booking) {
    const isDemo = connector.status === "demo";
    const guest = await tx.query<{ id: string }>("INSERT INTO guests (org_id, full_name, is_demo) VALUES ($1,$2,$3) RETURNING id", [orgId, b.guestName || "(chưa có tên từ kênh)", isDemo]);
    const created = await tx.query<BookingRow>(
      `INSERT INTO bookings (org_id, source_channel, source_account, external_ref, guest_id, booking_status, payment_status, check_in_date, check_out_date,
                             adults, children, total_guests, total_amount_minor, currency, source_version, source_updated_at, last_synced_at, booking_created_at, is_demo)
       VALUES ($1,$2,$3,$4,$5,'confirmed','channel_collects',$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),coalesce($14, now()),$15) RETURNING *`,
      [orgId, channel, event.sourceAccount ?? "", event.externalRef, guest.rows[0].id, b.checkInDate, b.checkOutDate, b.adults ?? null, b.children ?? null, total, b.totalAmountMinor ?? null, (b.currency ?? "EUR").toUpperCase(), event.sourceVersion ?? null, occurredAt, isDemo],
    );
    booking = created.rows[0];
    const alloc = await insertAllocation(tx, orgId, booking.id, { unitId, startDate: b.checkInDate, endDate: b.checkOutDate, guests: total }, { onConflict: "mark" });
    await recordBookingChange(tx, booking, "channel_created", null, src);
    await writeAudit(tx, actorForAudit, "connector.booking_created", "booking", booking.id, { externalRef: event.externalRef, conflict: alloc.status === "conflict" });
    return alloc.status === "conflict"
      ? { status: "conflict", bookingId: booking.id, message: "Booking đã lưu nhưng trùng tồn — đã mở cảnh báo xung đột." }
      : { status: "applied", bookingId: booking.id };
  }

  // Cập nhật booking đã có theo xác nhận của kênh
  booking = await lockBooking(tx, orgId, booking.id);
  const allocations = await activeAllocations(tx, booking.id);
  const sameStay =
    booking.check_in_date === b.checkInDate &&
    booking.check_out_date === b.checkOutDate &&
    allocations.length === 1 &&
    allocations[0].unit_id === unitId &&
    booking.booking_status !== "cancelled";
  let conflictHit = false;
  if (!sameStay) {
    for (const a of allocations) await releaseAllocation(tx, a.id);
    await tx.query("UPDATE bookings SET check_in_date = $2, check_out_date = $3, booking_status = 'confirmed' WHERE id = $1", [booking.id, b.checkInDate, b.checkOutDate]);
    const alloc = await insertAllocation(tx, orgId, booking.id, { unitId, startDate: b.checkInDate, endDate: b.checkOutDate, guests: total }, { onConflict: "mark" });
    conflictHit = alloc.status === "conflict";
  }
  await tx.query(
    `UPDATE bookings SET adults = coalesce($2, adults), children = coalesce($3, children), total_guests = coalesce($4, total_guests),
            total_amount_minor = coalesce($5, total_amount_minor), source_version = coalesce($6, source_version),
            source_updated_at = coalesce($7, source_updated_at), last_synced_at = now() WHERE id = $1`,
    [booking.id, b.adults ?? null, b.children ?? null, total, b.totalAmountMinor ?? null, event.sourceVersion ?? null, occurredAt],
  );
  await recordBookingChange(tx, booking, sameStay ? "channel_updated" : "channel_modified_stay", null, src);
  await writeAudit(tx, actorForAudit, "connector.booking_updated", "booking", booking.id, { externalRef: event.externalRef, stayChanged: !sameStay });
  return conflictHit
    ? { status: "conflict", bookingId: booking.id, message: "Kênh đổi lịch sang khoảng đã có khách — đã mở cảnh báo xung đột." }
    : { status: "applied", bookingId: booking.id };
}

export function measureLatency(occurredAt: string | null | undefined, receivedAt: Date = now()) {
  if (!occurredAt) return null;
  return Math.max(0, receivedAt.getTime() - new Date(occurredAt).getTime());
}
