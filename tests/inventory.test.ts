import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { createBooking, createInventoryBlock } from "@/modules/booking/service";
import { bookingInput, expectCode, makeFixture } from "./helpers";

describe("Tồn phòng nguyên căn / phòng lẻ", () => {
  it("đặt phòng lẻ chặn nguyên căn nhưng không chặn phòng lẻ khác", async () => {
    const f = await makeFixture();
    const staff = f.actors.vn_staff;
    await createBooking(staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-04"));
    await expectCode(createBooking(staff, bookingInput(f.units.whole, "2026-10-03", "2026-10-05")), "inventory_conflict");
    await createBooking(staff, bookingInput(f.units.r2, "2026-10-01", "2026-10-04"));
    await createBooking(staff, bookingInput(f.units.r3, "2026-10-02", "2026-10-03"));
  });

  it("đặt nguyên căn chặn mọi phòng lẻ thuộc căn, không chặn studio riêng", async () => {
    const f = await makeFixture();
    const staff = f.actors.vn_staff;
    await createBooking(staff, bookingInput(f.units.whole, "2026-10-10", "2026-10-12"));
    for (const room of [f.units.r1, f.units.r2, f.units.r3]) {
      const err = await expectCode(createBooking(staff, bookingInput(room, "2026-10-11", "2026-10-13")), "inventory_conflict");
      expect((err.details as { conflicts: unknown[] }).conflicts.length).toBeGreaterThan(0);
    }
    await createBooking(staff, bookingInput(f.units.studio, "2026-10-10", "2026-10-12"));
  });

  it("ngày trả của khách trước bằng ngày nhận của khách sau thì không trùng", async () => {
    const f = await makeFixture();
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    await createBooking(f.actors.vn_staff, bookingInput(f.units.whole, "2026-10-03", "2026-10-05"));
  });

  it("nguyên căn và phòng lẻ đặt đồng thời: chỉ một giao dịch chiếm được tài nguyên", async () => {
    const f = await makeFixture();
    const staff = f.actors.vn_staff;
    const results = await Promise.allSettled([
      createBooking(staff, bookingInput(f.units.whole, "2026-11-01", "2026-11-03")),
      createBooking(staff, bookingInput(f.units.r2, "2026-11-02", "2026-11-04")),
      createBooking(staff, bookingInput(f.units.r2, "2026-11-01", "2026-11-02")),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejectedCodes = results.filter((r) => r.status === "rejected").map((r) => ((r as PromiseRejectedResult).reason as { code: string }).code);
    expect(rejectedCodes.every((c) => c === "inventory_conflict")).toBe(true);
    // Hai booking phòng R2 không trùng nhau; nguyên căn trùng cả hai ⇒ hoặc 1 (nguyên căn) hoặc 2 (hai booking R2) thành công.
    expect([1, 2]).toContain(ok);
    const overlaps = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM resource_claims a JOIN resource_claims b ON a.resource_id = b.resource_id AND a.id < b.id
        WHERE a.active AND b.active AND a.stay && b.stay AND a.org_id = $1`,
      [f.orgId],
    );
    expect(overlaps[0].n).toBe(0);
  });

  it("chặn tồn bảo trì ngăn booking mới", async () => {
    const f = await makeFixture();
    await createInventoryBlock(f.actors.bp_coordinator, { unitId: f.units.r3, startDate: "2026-12-01", endDate: "2026-12-05", reason: "Sửa ống nước" });
    await expectCode(createBooking(f.actors.vn_staff, bookingInput(f.units.whole, "2026-12-04", "2026-12-06")), "inventory_conflict");
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-12-04", "2026-12-06"));
  });

  it("vượt sức chứa bị từ chối", async () => {
    const f = await makeFixture();
    await expectCode(createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-02", { adults: 3 })), "capacity_exceeded");
  });
});
