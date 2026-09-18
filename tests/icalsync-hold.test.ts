import { describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { addDays, todayOps } from "@/lib/time";
import { createBooking, createInventoryBlock } from "@/modules/booking/service";
import { addIcalFeed, setIcalHoldMode, syncFeed } from "@/modules/icalsync/service";
import { type Fixture, bookingInput, expectCode, makeFixture } from "./helpers";

const ics = (events: { start: string; end: string; uid?: string }[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((e, i) => [
      "BEGIN:VEVENT",
      `DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${e.end.replace(/-/g, "")}`,
      `UID:${e.uid ?? `ev-${i}`}@test`,
      "SUMMARY:Reserved",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");

const feedOf = (text: string) => async () => ({ ok: true, status: 200, text });

interface BlockRow {
  id: string;
  start_date: string;
  end_date: string;
  source: string;
  source_ref: string | null;
  active: boolean;
  reason: string;
}

/** Chặn tồn của một phòng, cả đang hiệu lực lẫn đã gỡ. */
const blocksOf = (unitId: string) =>
  query<BlockRow>("SELECT id, start_date, end_date, source, source_ref, active, reason FROM inventory_blocks WHERE unit_id = $1 ORDER BY start_date, created_at", [unitId]);

const activeClaims = (blockId: string) => query("SELECT id FROM resource_claims WHERE block_id = $1 AND active", [blockId]);

async function feedForR1(f: Fixture, secret: string) {
  const listing = (await queryOne<{ id: string }>("SELECT id FROM channel_listings WHERE unit_id = $1", [f.units.r1]))!.id;
  return addIcalFeed(f.actors.admin, { listingId: listing, url: `https://www.airbnb.com/calendar/ical/${secret}.ics?s=x` });
}

describe("iCal — giữ chỗ theo lịch kênh", () => {
  it("bật giữ chỗ: sinh chặn đúng khoảng, chạy lại không nhân đôi, khoảng biến mất thì gỡ", async () => {
    const f = await makeFixture();
    const today = todayOps();
    const d = (n: number) => addDays(today, n);
    const feed = await feedForR1(f, "h1");
    const cal = ics([{ start: d(3), end: d(6), uid: "a" }]);

    // Mặc định 'off': vẫn chỉ ghi lệch, không chặn tồn.
    await syncFeed(feed.id, feedOf(cal));
    expect(await blocksOf(f.units.r1)).toHaveLength(0);
    expect(await query("SELECT id FROM calendar_sync_findings WHERE feed_id = $1 AND status = 'open'", [feed.id])).toHaveLength(1);

    await expectCode(setIcalHoldMode(f.actors.vn_manager, feed.id, "block"), "forbidden");
    await setIcalHoldMode(f.actors.admin, feed.id, "block");

    const first = await syncFeed(feed.id, feedOf(cal));
    expect(first.ok && first.hold).toEqual({ created: 1, released: 0, skipped: 0 });
    const held = await blocksOf(f.units.r1);
    expect(held).toHaveLength(1);
    expect({ start: held[0].start_date, end: held[0].end_date, source: held[0].source, active: held[0].active }).toEqual({ start: d(3), end: d(6), source: "ical", active: true });
    expect(held[0].reason).toContain("Airbnb");
    expect(await activeClaims(held[0].id)).toHaveLength(1);
    // Chặn thật sự giữ tồn: không bán trùng được nữa.
    await expectCode(createBooking(f.actors.vn_staff, bookingInput(f.units.r1, d(4), d(5))), "inventory_conflict");
    // Lệch cũ tự đóng vì hệ thống đã bận đúng những đêm đó.
    expect(await query("SELECT id FROM calendar_sync_findings WHERE feed_id = $1 AND status = 'open'", [feed.id])).toHaveLength(0);

    // Chạy lại cùng lịch: giữ nguyên đúng một chặn, không tạo thêm.
    const second = await syncFeed(feed.id, feedOf(cal));
    expect(second.ok && second.hold).toEqual({ created: 0, released: 0, skipped: 0 });
    const again = await blocksOf(f.units.r1);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(held[0].id);

    // Khách huỷ trên kênh ⇒ khoảng bận biến mất ⇒ gỡ chặn, phòng mở bán lại.
    const third = await syncFeed(feed.id, feedOf(ics([])));
    expect(third.ok && third.hold).toEqual({ created: 0, released: 1, skipped: 0 });
    const released = (await blocksOf(f.units.r1))[0];
    expect(released.active).toBe(false);
    expect(await activeClaims(released.id)).toHaveLength(0);
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, d(4), d(5)));
  });

  it("sự kiện đổi ngày: gỡ chặn cũ và giữ chỗ khoảng mới", async () => {
    const f = await makeFixture();
    const today = todayOps();
    const d = (n: number) => addDays(today, n);
    const feed = await feedForR1(f, "h2");
    await setIcalHoldMode(f.actors.admin, feed.id, "block");

    await syncFeed(feed.id, feedOf(ics([{ start: d(10), end: d(12), uid: "same" }])));
    const moved = await syncFeed(feed.id, feedOf(ics([{ start: d(11), end: d(13), uid: "same" }])));
    expect(moved.ok && moved.hold).toEqual({ created: 1, released: 1, skipped: 0 });
    const rows = await blocksOf(f.units.r1);
    expect(rows.filter((r) => r.active).map((r) => [r.start_date, r.end_date])).toEqual([[d(11), d(13)]]);
    expect(rows.filter((r) => !r.active)).toHaveLength(1);
  });

  it("chặn do người tạo tay không bị đồng bộ gỡ", async () => {
    const f = await makeFixture();
    const today = todayOps();
    const d = (n: number) => addDays(today, n);
    const feed = await feedForR1(f, "h3");
    await setIcalHoldMode(f.actors.admin, feed.id, "block");
    const manual = await createInventoryBlock(f.actors.admin, { unitId: f.units.r1, startDate: d(20), endDate: d(22), reason: "Sửa vòi nước" });

    await syncFeed(feed.id, feedOf(ics([{ start: d(3), end: d(5), uid: "a" }])));
    await syncFeed(feed.id, feedOf(ics([])));
    const rows = await blocksOf(f.units.r1);
    const still = rows.find((r) => r.id === manual.id)!;
    expect({ source: still.source, active: still.active, ref: still.source_ref }).toEqual({ source: "manual", active: true, ref: null });
    expect(await activeClaims(manual.id)).toHaveLength(1);

    // Tắt giữ chỗ cũng chỉ gỡ chặn của link, không đụng chặn tay.
    await syncFeed(feed.id, feedOf(ics([{ start: d(3), end: d(5), uid: "a" }])));
    const off = await setIcalHoldMode(f.actors.admin, feed.id, "off");
    expect(off.releasedBlocks).toBe(1);
    const after = await blocksOf(f.units.r1);
    expect(after.filter((r) => r.active).map((r) => r.id)).toEqual([manual.id]);
  });

  it("trùng booking thật: chỉ giữ đêm còn trống, không chặn đè lên đêm của khách", async () => {
    const f = await makeFixture();
    const today = todayOps();
    const d = (n: number) => addDays(today, n);
    const feed = await feedForR1(f, "h4");
    await setIcalHoldMode(f.actors.admin, feed.id, "block");
    const booking = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, d(10), d(12)));

    // Kênh báo bận d9→d12, hệ thống đã có khách d10→d12: cắt ra, chỉ giữ đêm d9 còn trống.
    const r = await syncFeed(feed.id, feedOf(ics([{ start: d(9), end: d(12), uid: "x" }])));
    expect(r.ok && r.hold).toEqual({ created: 1, released: 0, skipped: 1 });
    expect((await blocksOf(f.units.r1)).filter((b) => b.source === "ical" && b.active).map((b) => [b.start_date, b.end_date])).toEqual([[d(9), d(10)]]);
    // Booking của khách nguyên vẹn.
    const alloc = await query<{ status: string; start_date: string; end_date: string }>(
      "SELECT status, start_date, end_date FROM booking_allocations WHERE booking_id = $1",
      [booking.id],
    );
    expect(alloc).toEqual([{ status: "active", start_date: d(10), end_date: d(12) }]);
    // Cả ba đêm giờ đều bận trong hệ thống (d9 do chặn, d10–d12 do khách) ⇒ không còn lệch để báo.
    expect(await query("SELECT id FROM calendar_sync_findings WHERE feed_id = $1 AND status = 'open'", [feed.id])).toHaveLength(0);
  });

  it("sự kiện gia hạn đụng chặn tay: giữ nguyên chỗ đang chặn, không để hở đêm nào", async () => {
    const f = await makeFixture();
    const today = todayOps();
    const d = (n: number) => addDays(today, n);
    const feed = await feedForR1(f, "h6");
    await setIcalHoldMode(f.actors.admin, feed.id, "block");
    await syncFeed(feed.id, feedOf(ics([{ start: d(40), end: d(42), uid: "same" }])));
    const before = (await blocksOf(f.units.r1)).filter((b) => b.source === "ical" && b.active);
    expect(before).toHaveLength(1);
    // Người vận hành chặn tay d42→d44 để bảo trì.
    await createInventoryBlock(f.actors.admin, { unitId: f.units.r1, startDate: d(42), endDate: d(44), reason: "Bảo trì" });

    // Khách gia hạn trên kênh: CÙNG mã sự kiện, giờ là d40→d44 — phần gia hạn đụng chặn tay.
    const r = await syncFeed(feed.id, feedOf(ics([{ start: d(40), end: d(44), uid: "same" }])));
    expect(r.ok && r.hold).toEqual({ created: 0, released: 0, skipped: 1 });
    const after = (await blocksOf(f.units.r1)).filter((b) => b.source === "ical" && b.active);
    expect(after.map((b) => b.id)).toEqual([before[0].id]);
    expect([after[0].start_date, after[0].end_date]).toEqual([d(40), d(42)]);
    // Chỗ đang giữ không được mất: vẫn không bán được đêm kênh đang có khách.
    await expectCode(createBooking(f.actors.vn_staff, bookingInput(f.units.r1, d(40), d(41))), "inventory_conflict");
  });

  it("lưu trú đang diễn ra: 'hôm nay' trượt sang ngày mới không làm gỡ–tạo lại chặn", async () => {
    const f = await makeFixture();
    const today = todayOps();
    const d = (n: number) => addDays(today, n);
    const feed = await feedForR1(f, "h7");
    await setIcalHoldMode(f.actors.admin, feed.id, "block");
    const cal = ics([{ start: d(-2), end: d(3), uid: "stay" }]);

    await syncFeed(feed.id, feedOf(cal));
    const first = (await blocksOf(f.units.r1)).filter((b) => b.active)[0];
    expect([first.start_date, first.end_date]).toEqual([d(0), d(3)]); // không chặn ngược về quá khứ
    // Giả lập chặn này được tạo từ hôm qua (lúc đó "hôm nay" là d-1) rồi đồng bộ lại đúng sự kiện cũ.
    await query("UPDATE inventory_blocks SET start_date = $2 WHERE id = $1", [first.id, d(-1)]);
    await query("UPDATE resource_claims SET stay = daterange($2::date, upper(stay)) WHERE block_id = $1 AND active", [first.id, d(-1)]);

    const r = await syncFeed(feed.id, feedOf(cal));
    expect(r.ok && r.hold).toEqual({ created: 0, released: 0, skipped: 0 });
    const after = (await blocksOf(f.units.r1)).filter((b) => b.active);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first.id);
    expect(after[0].start_date).toBe(d(-1));
  });

  it("xoá link thì gỡ chặn do link sinh ra", async () => {
    const { removeIcalFeed } = await import("@/modules/icalsync/service");
    const f = await makeFixture();
    const today = todayOps();
    const d = (n: number) => addDays(today, n);
    const feed = await feedForR1(f, "h5");
    await setIcalHoldMode(f.actors.admin, feed.id, "block");
    await syncFeed(feed.id, feedOf(ics([{ start: d(30), end: d(32), uid: "a" }])));
    expect((await blocksOf(f.units.r1)).filter((b) => b.active)).toHaveLength(1);

    const removed = await removeIcalFeed(f.actors.admin, feed.id);
    expect(removed.releasedBlocks).toBe(1);
    expect((await blocksOf(f.units.r1)).filter((b) => b.active)).toHaveLength(0);
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, d(30), d(32)));
  });
});
