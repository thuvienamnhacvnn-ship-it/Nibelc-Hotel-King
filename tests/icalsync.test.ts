import { describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { addDays, todayOps } from "@/lib/time";
import { createBooking } from "@/modules/booking/service";
import { maskUrl, parseIcal, toRanges } from "@/modules/icalsync/parse";
import { addIcalFeed, syncFeed, validateIcalUrl } from "@/modules/icalsync/service";
import { bookingInput, expectCode, makeFixture } from "./helpers";

const ics = (events: { start: string; end: string; summary?: string }[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((e, i) => [
      "BEGIN:VEVENT",
      `DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${e.end.replace(/-/g, "")}`,
      `UID:ev-${i}@test`,
      `SUMMARY:${e.summary ?? "Reserved"}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");

describe("iCal chỉ đọc", () => {
  it("đọc sự kiện ngày, gộp khoảng liên tiếp, không giữ tên trong SUMMARY", () => {
    const { ranges } = parseIcal(ics([{ start: "2026-10-01", end: "2026-10-03", summary: "Nguyen Van A (HMABC)" }]));
    expect(ranges).toEqual([{ uid: "ev-0@test", start: "2026-10-01", end: "2026-10-03" }]);
    expect(JSON.stringify(ranges)).not.toContain("Nguyen");
    expect(toRanges(["2026-10-02", "2026-10-01", "2026-10-05"])).toEqual([
      { start: "2026-10-01", end: "2026-10-03" },
      { start: "2026-10-05", end: "2026-10-06" },
    ]);
  });

  it("chỉ nhận link https của Airbnb/Booking.com; link bị che khi hiển thị", () => {
    expect(() => validateIcalUrl("http://www.airbnb.com/calendar/ical/1.ics?s=abc")).toThrow();
    expect(() => validateIcalUrl("https://169.254.169.254/latest")).toThrow();
    expect(() => validateIcalUrl("https://evil.example/booking.com.ics")).toThrow();
    expect(validateIcalUrl("https://www.airbnb.com/calendar/ical/123.ics?s=secret")).toContain("airbnb.com");
    expect(validateIcalUrl("https://admin.booking.com/hotel/hoteladmin/ical.html?t=tok")).toContain("booking.com");
    expect(maskUrl("https://www.airbnb.com/calendar/ical/123.ics?s=secrettoken1234")).toBe("https://www.airbnb.com/…1234");
  });

  it("đối chiếu: kênh bận mà hệ thống trống, hệ thống có booking mà kênh trống; lần sau hết lệch thì tự đóng", async () => {
    const f = await makeFixture();
    const today = todayOps();
    const d = (n: number) => addDays(today, n);
    const listing = (await queryOne<{ id: string }>("SELECT id FROM channel_listings WHERE unit_id = $1", [f.units.r1]))!.id;
    await expectCode(addIcalFeed(f.actors.vn_manager, { listingId: listing, url: "https://www.airbnb.com/calendar/ical/1.ics?s=x" }), "forbidden");
    const feed = await addIcalFeed(f.actors.admin, { listingId: listing, url: "https://www.airbnb.com/calendar/ical/1.ics?s=x" });
    // Booking cũ (quá thời gian chờ đồng bộ) trên R1 từ d5 tới d7
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, d(5), d(7)));
    await query("UPDATE resource_claims SET created_at = now() - interval '1 day' WHERE allocation_id IN (SELECT id FROM booking_allocations WHERE booking_id = $1)", [b.id]);

    const first = await syncFeed(feed.id, async () => ({ ok: true, status: 200, text: ics([{ start: d(1), end: d(3) }]) }));
    expect(first.ok).toBe(true);
    const open = await query<{ kind: string; start_date: string; end_date: string }>(
      "SELECT kind, start_date, end_date FROM calendar_sync_findings WHERE feed_id = $1 AND status = 'open' ORDER BY kind",
      [feed.id],
    );
    expect(open).toEqual([
      { kind: "channel_busy_not_in_system", start_date: d(1), end_date: d(3) },
      { kind: "system_busy_channel_free", start_date: d(5), end_date: d(7) },
    ]);
    // Chạy lại cùng dữ liệu: không nhân bản
    await syncFeed(feed.id, async () => ({ ok: true, status: 200, text: ics([{ start: d(1), end: d(3) }]) }));
    expect((await query("SELECT id FROM calendar_sync_findings WHERE feed_id = $1", [feed.id])).length).toBe(2);
    // Kênh đã đóng đêm d5–d7, khách d1–d3 đã được nhập tay: hết lệch ⇒ tự đóng
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, d(1), d(3)));
    await syncFeed(feed.id, async () => ({ ok: true, status: 200, text: ics([{ start: d(1), end: d(3) }, { start: d(5), end: d(7) }]) }));
    const stillOpen = await query("SELECT id FROM calendar_sync_findings WHERE feed_id = $1 AND status = 'open'", [feed.id]);
    expect(stillOpen).toHaveLength(0);
  });

  it("tải lỗi: ghi lỗi, không xoá phát hiện cũ, không tuyên bố đồng bộ thành công", async () => {
    const f = await makeFixture();
    const listing = (await queryOne<{ id: string }>("SELECT id FROM channel_listings WHERE unit_id = $1", [f.units.r1]))!.id;
    const feed = await addIcalFeed(f.actors.admin, { listingId: listing, url: "https://www.airbnb.com/calendar/ical/2.ics?s=y" });
    const r = await syncFeed(feed.id, async () => ({ ok: false, status: 503, text: "" }));
    expect(r.ok).toBe(false);
    const row = await queryOne<{ last_success_at: Date | null; last_error: string }>("SELECT last_success_at, last_error FROM ical_feeds WHERE id = $1", [feed.id]);
    expect(row!.last_success_at).toBeNull();
    expect(row!.last_error).toContain("503");
  });
});
