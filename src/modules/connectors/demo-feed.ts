import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, query, queryOne } from "@/lib/db";
import { AppError, forbidden, notFound } from "@/lib/errors";
import { addDays, todayOps } from "@/lib/time";
import { type Actor, can } from "@/modules/auth/actor";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";
import { type InboundBookingEvent, type IngestResult, ingestBookingEvent } from "@/modules/connectors/ingest";
import { findConflicts } from "@/modules/inventory/inventory";

/**
 * Nguồn sự kiện DEMO: sinh sự kiện giả lập GẮN NHÃN DEMO rồi đi qua đúng đường nhận thật (ingestBookingEvent),
 * để thấy xử lý trùng / sai thứ tự / đổi ngày / hủy / xung đột. Chỉ chạy trên connector status = 'demo'.
 * Booking tạo ra mang is_demo do ingest kế thừa từ connector demo. Không gọi kênh ngoài nào. Độ trễ nguồn → nhận là giả lập (thời điểm phát sinh lùi vài giây).
 */

export const DEMO_SCENARIOS = ["new", "resend", "stale", "dates", "cancel", "conflict"] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export const DEMO_SCENARIO_LABELS: Record<DemoScenario, string> = {
  new: "Booking mới",
  resend: "Gửi lại sự kiện vừa rồi (trùng)",
  stale: "Sự kiện phiên bản cũ (sai thứ tự)",
  dates: "Kênh đổi ngày",
  cancel: "Kênh hủy",
  conflict: "Booking trùng đêm (xung đột)",
};

/** Ai được bấm: connector.manage (admin) hoặc người duyệt thay đổi booking có quyền xem kết nối (vn_manager). */
export function canRunDemoFeed(actor: Actor) {
  return can(actor, "connector.manage") || (can(actor, "connector.view") && can(actor, "booking.approve_change"));
}

const input = z.object({
  scenario: z.enum(DEMO_SCENARIOS, { message: "Kịch bản DEMO không hợp lệ" }),
  /** Tuỳ chọn: mã booking kênh (mới) hoặc booking đích (đổi ngày/hủy/phiên bản cũ). Chỉ chữ hoa, số, gạch ngang. */
  externalRef: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]{3,40}$/, "Mã tham chiếu chỉ gồm chữ hoa, số, gạch ngang (3–40 ký tự)")
    .optional()
    .nullable(),
});

interface DemoConnector {
  id: string;
  channel: string;
  label: string;
  status: string;
}

interface TargetBooking {
  id: string;
  external_ref: string;
  source_account: string;
  check_in_date: string;
  check_out_date: string;
  source_version: number | null;
  source_updated_at: Date | null;
  adults: number | null;
  unit_code: string | null;
  listing_id: string | null;
}

const eventId = () => `demo-feed-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const newRef = () => `DEMO-FEED-${Date.now().toString(36).toUpperCase()}`;
/**
 * Thời điểm phát sinh giả lập: lùi 1,5–8 giây so với lúc gửi, nhưng không sớm hơn `notBefore`
 * (thời điểm nguồn của trạng thái đang lưu) để sự kiện mới không bị coi là cũ, và không bao giờ ở tương lai.
 */
const simulatedOccurredAt = (notBefore = 0) => {
  const nowMs = Date.now();
  return new Date(Math.min(nowMs, Math.max(notBefore + 1, nowMs - 1500 - Math.floor(Math.random() * 6500)))).toISOString();
};

async function listingsForChannel(orgId: string, channel: string) {
  // Chỉ mã listing ánh xạ đúng một sản phẩm — ingest từ chối mã trùng.
  return query<{ external_listing_id: string; unit_id: string; unit_code: string; capacity: number }>(
    `SELECT l.external_listing_id, u.id AS unit_id, u.code AS unit_code, u.capacity
       FROM channel_listings l JOIN units u ON u.id = l.unit_id AND u.org_id = $1
      WHERE l.org_id = $1 AND l.channel = $2 AND l.external_listing_id IS NOT NULL AND u.active
        AND (SELECT count(*) FROM channel_listings l2 WHERE l2.org_id = $1 AND l2.channel = $2 AND l2.external_listing_id = l.external_listing_id) = 1
      ORDER BY u.kind = 'whole', u.sort_order, u.code`,
    [orgId, channel],
  );
}

async function targetBooking(orgId: string, connector: DemoConnector, ref: string | null): Promise<TargetBooking> {
  const row = await queryOne<TargetBooking>(
    `SELECT b.id, b.external_ref, b.source_account, b.check_in_date, b.check_out_date, b.source_version, b.source_updated_at, b.adults,
            u.code AS unit_code,
            (SELECT l.external_listing_id FROM channel_listings l WHERE l.org_id = $1 AND l.unit_id = u.id AND l.channel = $3 AND l.external_listing_id IS NOT NULL LIMIT 1) AS listing_id
       FROM bookings b
       LEFT JOIN LATERAL (SELECT a.unit_id FROM booking_allocations a WHERE a.booking_id = b.id AND a.status IN ('active','conflict') ORDER BY a.start_date LIMIT 1) al ON true
       LEFT JOIN units u ON u.id = al.unit_id
      WHERE b.org_id = $1 AND b.source_channel = $3 AND b.booking_status <> 'cancelled' AND b.external_ref IS NOT NULL
        AND ($4::text IS NULL OR b.external_ref = $4::text)
        AND EXISTS (SELECT 1 FROM inbound_events e WHERE e.booking_id = b.id AND e.connector_id = $2 AND e.org_id = $1)
      ORDER BY (SELECT max(e.received_at) FROM inbound_events e WHERE e.booking_id = b.id AND e.connector_id = $2) DESC
      LIMIT 1`,
    [orgId, connector.id, connector.channel, ref],
  );
  if (!row) {
    throw new AppError(
      "demo_no_target",
      ref ? `Không có booking ${ref} (chưa hủy) nhận từ nguồn DEMO này.` : "Chưa có booking nào (chưa hủy) nhận từ nguồn DEMO này — bấm “Booking mới” trước.",
      409,
    );
  }
  if (!row.listing_id && !row.unit_code) throw new AppError("demo_no_target", `Booking ${row.external_ref} không còn phân bổ phòng để dựng sự kiện.`, 409);
  return row;
}

function bookingPart(t: TargetBooking, checkIn: string, checkOut: string, adults: number | null) {
  return {
    listingExternalId: t.listing_id,
    unitCode: t.listing_id ? null : t.unit_code,
    checkInDate: checkIn,
    checkOutDate: checkOut,
    guestName: "Khách DEMO (giả lập kênh)",
    adults,
  };
}

async function buildEvent(actor: Actor, connector: DemoConnector, scenario: DemoScenario, ref: string | null): Promise<InboundBookingEvent> {
  const org = actor.orgId;
  const today = todayOps(actor.timezone);

  if (scenario === "new") {
    const listings = await listingsForChannel(org, connector.channel);
    if (!listings.length) throw new AppError("demo_no_listing", "Không có listing nào của kênh này có mã listing ngoài để giả lập.", 409);
    for (let offset = 10; offset <= 90; offset += 2) {
      for (const l of listings) {
        const start = addDays(today, offset);
        const end = addDays(start, 2);
        if ((await findConflicts(pool(), org, l.unit_id, start, end)).length === 0) {
          return {
            externalEventId: eventId(),
            type: "booking.upsert",
            externalRef: ref ?? newRef(),
            sourceAccount: "",
            sourceVersion: 1,
            occurredAt: simulatedOccurredAt(),
            booking: { listingExternalId: l.external_listing_id, checkInDate: start, checkOutDate: end, guestName: "Khách DEMO (giả lập kênh)", adults: Math.min(2, l.capacity) },
          };
        }
      }
    }
    throw new AppError("demo_no_free_slot", "Không tìm được 2 đêm trống trong 90 ngày tới để giả lập booking mới.", 409);
  }

  if (scenario === "resend") {
    const last = await queryOne<{ payload: InboundBookingEvent }>(
      `SELECT payload FROM inbound_events WHERE org_id = $1 AND connector_id = $2 AND status <> 'failed' AND external_event_id LIKE 'demo-%'
        ORDER BY received_at DESC LIMIT 1`,
      [org, connector.id],
    );
    if (!last) throw new AppError("demo_no_target", "Nguồn DEMO chưa gửi sự kiện nào để gửi lại.", 409);
    return last.payload; // giữ nguyên externalEventId ⇒ phải ra "duplicate"
  }

  if (scenario === "conflict") {
    // Chọn một phân bổ đang giữ phòng sắp tới trên sản phẩm có listing của kênh, rồi bán trùng đêm đầu tiên.
    const hit = await queryOne<{ external_listing_id: string; start_date: string; end_date: string; unit_code: string; booking_ref: string | null }>(
      `SELECT l.external_listing_id, a.start_date, a.end_date, u.code AS unit_code, b.external_ref AS booking_ref
         FROM booking_allocations a
         JOIN bookings b ON b.id = a.booking_id AND b.booking_status <> 'cancelled'
         JOIN units u ON u.id = a.unit_id AND u.org_id = $1 AND u.active
         JOIN channel_listings l ON l.unit_id = u.id AND l.org_id = $1 AND l.channel = $2 AND l.external_listing_id IS NOT NULL
        WHERE a.org_id = $1 AND a.status = 'active' AND a.start_date >= $3
          AND (SELECT count(*) FROM channel_listings l2 WHERE l2.org_id = $1 AND l2.channel = $2 AND l2.external_listing_id = l.external_listing_id) = 1
        ORDER BY a.start_date, u.code LIMIT 1`,
      [org, connector.channel, today],
    );
    if (!hit) throw new AppError("demo_no_target", "Không có booking sắp tới nào trên listing của kênh này để giả lập trùng đêm.", 409);
    return {
      externalEventId: eventId(),
      type: "booking.upsert",
      externalRef: ref ?? newRef(),
      sourceAccount: "",
      sourceVersion: 1,
      occurredAt: simulatedOccurredAt(),
      booking: { listingExternalId: hit.external_listing_id, checkInDate: hit.start_date, checkOutDate: addDays(hit.start_date, 1), guestName: "Khách DEMO (giả lập trùng đêm)", adults: 1 },
    };
  }

  const t = await targetBooking(org, connector, ref);
  if (scenario === "stale") {
    const current = t.source_version ?? 1;
    const before = t.source_updated_at ? new Date(t.source_updated_at).getTime() : Date.now();
    return {
      externalEventId: eventId(),
      type: "booking.upsert",
      externalRef: t.external_ref,
      sourceAccount: t.source_account,
      sourceVersion: Math.max(0, current - 1),
      occurredAt: new Date(before - 3600_000).toISOString(),
      booking: bookingPart(t, addDays(t.check_in_date, -1), t.check_out_date, t.adults),
    };
  }
  const nextVersion = (t.source_version ?? 0) + 1;
  // Thời điểm phát sinh phải sau trạng thái đang lưu, nếu không ingest coi là cũ.
  const notBefore = t.source_updated_at ? new Date(t.source_updated_at).getTime() : 0;
  if (scenario === "dates") {
    return {
      externalEventId: eventId(),
      type: "booking.upsert",
      externalRef: t.external_ref,
      sourceAccount: t.source_account,
      sourceVersion: nextVersion,
      occurredAt: simulatedOccurredAt(notBefore),
      booking: bookingPart(t, addDays(t.check_in_date, 1), addDays(t.check_out_date, 1), t.adults),
    };
  }
  return {
    externalEventId: eventId(),
    type: "booking.cancelled",
    externalRef: t.external_ref,
    sourceAccount: t.source_account,
    sourceVersion: nextVersion,
    occurredAt: simulatedOccurredAt(notBefore),
    booking: null,
  };
}

export async function runDemoScenario(actor: Actor, connectorId: string, raw: unknown) {
  if (!canRunDemoFeed(actor)) throw forbidden("Cần quyền quản lý kết nối hoặc duyệt thay đổi booking để chạy nguồn DEMO.");
  if (!z.string().uuid().safeParse(connectorId).success) throw notFound("connector");
  const { scenario, externalRef } = input.parse(raw);
  const connector = await queryOne<DemoConnector>("SELECT id, channel, label, status FROM connector_accounts WHERE id = $1 AND org_id = $2", [connectorId, actor.orgId]);
  if (!connector) throw notFound("connector");
  if (connector.status !== "demo") throw new AppError("not_demo_connector", "Chỉ connector ở trạng thái DEMO mới được sinh sự kiện giả lập.", 409);

  const event = await buildEvent(actor, connector, scenario, externalRef ?? null);
  const result: IngestResult = await ingestBookingEvent(actor.orgId, connector.id, event);

  await writeAudit(null, auditActorOf(actor), "connector.demo_event", "connector", connector.id, {
    scenario,
    externalEventId: event.externalEventId,
    externalRef: event.externalRef,
    status: result.status,
    bookingId: result.bookingId,
  });

  const booking = result.bookingId
    ? await queryOne<{ id: string; external_ref: string | null; booking_status: string; check_in_date: string; check_out_date: string }>(
        "SELECT id, external_ref, booking_status, check_in_date, check_out_date FROM bookings WHERE id = $1 AND org_id = $2",
        [result.bookingId, actor.orgId],
      )
    : null;

  return {
    demo: true,
    scenario,
    event: {
      externalEventId: event.externalEventId,
      type: event.type,
      externalRef: event.externalRef,
      sourceVersion: event.sourceVersion ?? null,
      occurredAt: event.occurredAt ?? null,
      checkInDate: event.booking?.checkInDate ?? null,
      checkOutDate: event.booking?.checkOutDate ?? null,
      listing: event.booking?.listingExternalId ?? event.booking?.unitCode ?? null,
    },
    result,
    booking,
  };
}
