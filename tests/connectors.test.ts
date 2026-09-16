import { describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { ingestBookingEvent } from "@/modules/connectors/ingest";
import { makeFixture, runWorker, tasksFor, uid } from "./helpers";

function upsert(listing: string, ref: string, eventId: string, extra: Record<string, unknown> = {}, booking: Record<string, unknown> = {}) {
  return {
    externalEventId: eventId,
    type: "booking.upsert",
    externalRef: ref,
    booking: { listingExternalId: listing, checkInDate: "2026-10-10", checkOutDate: "2026-10-12", guestName: "Guest Demo", adults: 2, ...booking },
    ...extra,
  };
}

describe("Trợ lý 1 — nhận sự kiện booking", () => {
  it("một sự kiện gửi lại nhiều lần: một booking, một lịch sử, một việc dọn", async () => {
    const f = await makeFixture();
    const listing = (await queryOne<{ external_listing_id: string }>("SELECT external_listing_id FROM channel_listings WHERE unit_id = $1", [f.units.r1]))!.external_listing_id;
    const ref = `HM-${uid()}`;
    const ev = upsert(listing, ref, `ev-${uid()}`, { sourceVersion: 1 });
    const first = await ingestBookingEvent(f.orgId, f.connectorId, ev);
    const second = await ingestBookingEvent(f.orgId, f.connectorId, ev);
    const third = await ingestBookingEvent(f.orgId, f.connectorId, ev);
    expect(first.status).toBe("applied");
    expect([second.status, third.status]).toEqual(["duplicate", "duplicate"]);
    expect(second.bookingId).toBe(first.bookingId);
    await runWorker();
    await runWorker();
    const bookings = await query("SELECT id FROM bookings WHERE org_id = $1 AND external_ref = $2", [f.orgId, ref]);
    expect(bookings).toHaveLength(1);
    const changes = await query("SELECT id FROM booking_changes WHERE booking_id = $1", [first.bookingId]);
    expect(changes).toHaveLength(1);
    expect(await tasksFor(f.orgId)).toHaveLength(1);
  });

  it("sự kiện đến sai thứ tự không ghi đè trạng thái mới", async () => {
    const f = await makeFixture();
    const listing = `AB-R1-${(await queryOne<{ code: string }>("SELECT code FROM units WHERE id = $1", [f.units.r1]))!.code.split("-")[1]}`;
    const ref = `HM-${uid()}`;
    const v2 = upsert(listing, ref, `ev2-${uid()}`, { sourceVersion: 2 }, { checkOutDate: "2026-10-14" });
    const v1 = upsert(listing, ref, `ev1-${uid()}`, { sourceVersion: 1 }, { checkOutDate: "2026-10-12" });
    expect((await ingestBookingEvent(f.orgId, f.connectorId, v2)).status).toBe("applied");
    const stale = await ingestBookingEvent(f.orgId, f.connectorId, v1);
    expect(stale.status).toBe("stale");
    const row = await queryOne<{ check_out_date: string }>("SELECT check_out_date FROM bookings WHERE org_id = $1 AND external_ref = $2", [f.orgId, ref]);
    expect(row!.check_out_date).toBe("2026-10-14");
  });

  it("nguồn không có phiên bản/thời điểm: không ghi đè, chuyển đối soát", async () => {
    const f = await makeFixture();
    const listing = (await queryOne<{ external_listing_id: string }>("SELECT external_listing_id FROM channel_listings WHERE unit_id = $1", [f.units.r1]))!.external_listing_id;
    const ref = `HM-${uid()}`;
    await ingestBookingEvent(f.orgId, f.connectorId, upsert(listing, ref, `a-${uid()}`));
    const second = await ingestBookingEvent(f.orgId, f.connectorId, upsert(listing, ref, `b-${uid()}`, {}, { checkOutDate: "2026-10-20" }));
    expect(second.status).toBe("needs_reconcile");
    const row = await queryOne<{ check_out_date: string }>("SELECT check_out_date FROM bookings WHERE org_id = $1 AND external_ref = $2", [f.orgId, ref]);
    expect(row!.check_out_date).toBe("2026-10-12");
  });

  it("kênh bán trùng đêm đã có khách: vẫn lưu booking, đánh dấu xung đột, không giữ tồn", async () => {
    const f = await makeFixture();
    const whole = (await queryOne<{ external_listing_id: string }>("SELECT external_listing_id FROM channel_listings WHERE unit_id = $1", [f.units.whole]))!.external_listing_id;
    const r1 = (await queryOne<{ external_listing_id: string }>("SELECT external_listing_id FROM channel_listings WHERE unit_id = $1", [f.units.r1]))!.external_listing_id;
    await ingestBookingEvent(f.orgId, f.connectorId, upsert(whole, `W-${uid()}`, `w-${uid()}`, { sourceVersion: 1 }));
    const clash = await ingestBookingEvent(f.orgId, f.connectorId, upsert(r1, `R-${uid()}`, `r-${uid()}`, { sourceVersion: 1 }, { checkInDate: "2026-10-11", checkOutDate: "2026-10-13" }));
    expect(clash.status).toBe("conflict");
    const conflicts = await query("SELECT id FROM inventory_conflicts WHERE org_id = $1 AND status = 'open'", [f.orgId]);
    expect(conflicts).toHaveLength(1);
    const alloc = await queryOne<{ status: string }>("SELECT status FROM booking_allocations WHERE booking_id = $1", [clash.bookingId]);
    expect(alloc!.status).toBe("conflict");
  });

  it("sự kiện lỗi (chưa có mapping) được xử lý lại sau khi sửa mapping", async () => {
    const f = await makeFixture();
    const ev = upsert(`UNKNOWN-${uid()}`, `HM-${uid()}`, `ev-${uid()}`, { sourceVersion: 1 });
    const failed = await ingestBookingEvent(f.orgId, f.connectorId, ev);
    expect(failed.status).toBe("failed");
    const conn = await queryOne<{ last_error: string | null }>("SELECT last_error FROM connector_accounts WHERE id = $1", [f.connectorId]);
    expect(conn!.last_error).toContain("mapping");
    await query("INSERT INTO channel_listings (org_id, unit_id, channel, external_listing_id) VALUES ($1,$2,'airbnb',$3)", [f.orgId, f.units.studio, ev.booking.listingExternalId]);
    const retried = await ingestBookingEvent(f.orgId, f.connectorId, ev);
    expect(retried.status).toBe("applied");
  });

  it("hủy từ kênh giải phóng tồn và hủy việc dọn chưa nhận", async () => {
    const f = await makeFixture();
    const listing = (await queryOne<{ external_listing_id: string }>("SELECT external_listing_id FROM channel_listings WHERE unit_id = $1", [f.units.r1]))!.external_listing_id;
    const ref = `HM-${uid()}`;
    await ingestBookingEvent(f.orgId, f.connectorId, upsert(listing, ref, `c1-${uid()}`, { sourceVersion: 1 }));
    await runWorker();
    expect((await tasksFor(f.orgId))[0].status).toBe("pending_assignment");
    const cancelled = await ingestBookingEvent(f.orgId, f.connectorId, { externalEventId: `c2-${uid()}`, type: "booking.cancelled", externalRef: ref, sourceVersion: 2 });
    expect(cancelled.status).toBe("applied");
    await runWorker();
    expect((await tasksFor(f.orgId))[0].status).toBe("cancelled");
  });
});
