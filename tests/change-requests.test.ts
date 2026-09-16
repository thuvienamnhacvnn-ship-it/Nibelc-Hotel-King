import { describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { applyChangeRequest, createBooking, requestChange, updateBookingDetails } from "@/modules/booking/service";
import { bookingInput, expectCode, makeFixture, runWorker, tasksFor } from "./helpers";

async function bookingRow(id: string) {
  return (await queryOne<{ check_in_date: string; check_out_date: string; version: number; booking_status: string }>(
    "SELECT check_in_date, check_out_date, version, booking_status FROM bookings WHERE id = $1",
    [id],
  ))!;
}

describe("Yêu cầu thay đổi tách khỏi thay đổi đã xác nhận", () => {
  it("yêu cầu đổi ngày đang chờ không sửa booking thật", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    const cr = await requestChange(f.actors.bp_coordinator, b.id, { kind: "dates", checkInDate: "2026-10-01", checkOutDate: "2026-10-05" }, { source: "guest_message" });
    expect(cr.applied).toBe(false);
    expect(cr.check.ok).toBe(true);
    const row = await bookingRow(b.id);
    expect(row.check_out_date).toBe("2026-10-03");
    const claims = await query<{ stay: string }>("SELECT stay::text FROM resource_claims c JOIN booking_allocations a ON a.id = c.allocation_id WHERE a.booking_id = $1 AND c.active", [b.id]);
    expect(claims.map((c) => c.stay)).toEqual(["[2026-10-01,2026-10-03)"]);
  });

  it("người không có quyền duyệt không áp dụng được; người có quyền áp dụng thì tồn phòng đổi theo", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    const cr = await requestChange(f.actors.vn_staff, b.id, { kind: "dates", checkInDate: "2026-10-01", checkOutDate: "2026-10-05" });
    await expectCode(applyChangeRequest(f.actors.vn_staff, cr.id), "forbidden");
    const applied = await applyChangeRequest(f.actors.vn_manager, cr.id);
    expect(applied.superseded).toBe(false);
    expect((await bookingRow(b.id)).check_out_date).toBe("2026-10-05");
    // Đêm cũ và đêm mới đều thuộc booking này; phòng lẻ khác vẫn đặt được.
    await expectCode(createBooking(f.actors.vn_staff, bookingInput(f.units.whole, "2026-10-04", "2026-10-06")), "inventory_conflict");
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r2, "2026-10-04", "2026-10-06"));
  });

  it("booking đổi phiên bản trước khi duyệt ⇒ phiếu cũ hết hiệu lực", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    const cr = await requestChange(f.actors.vn_staff, b.id, { kind: "guests", adults: 2, children: 0 });
    await updateBookingDetails(f.actors.vn_staff, b.id, { expectedVersion: b.version, opsNote: "Khách gọi điện" });
    const result = await applyChangeRequest(f.actors.vn_manager, cr.id);
    expect(result.superseded).toBe(true);
    const status = await queryOne<{ status: string }>("SELECT status FROM change_requests WHERE id = $1", [cr.id]);
    expect(status!.status).toBe("superseded");
  });

  it("đổi ngày vào khoảng đã có khách: 409, phiếu vẫn chờ và lưu lý do", async () => {
    const f = await makeFixture();
    const a = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-03", "2026-10-06"));
    const cr = await requestChange(f.actors.vn_staff, a.id, { kind: "dates", checkInDate: "2026-10-01", checkOutDate: "2026-10-04" });
    expect(cr.check.ok).toBe(false);
    await expectCode(applyChangeRequest(f.actors.vn_manager, cr.id), "inventory_conflict");
    const row = await queryOne<{ status: string; check_result: { ok: boolean } }>("SELECT status, check_result FROM change_requests WHERE id = $1", [cr.id]);
    expect(row!.status).toBe("pending");
    expect(row!.check_result.ok).toBe(false);
    expect((await bookingRow(a.id)).check_out_date).toBe("2026-10-03");
  });

  it("gửi sửa thông tin với phiên bản cũ bị từ chối (chống ghi đè)", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    await updateBookingDetails(f.actors.vn_staff, b.id, { expectedVersion: b.version, opsNote: "A" });
    await expectCode(updateBookingDetails(f.actors.vn_manager, b.id, { expectedVersion: b.version, opsNote: "B" }), "stale_version");
  });

  it("đổi phòng giữa kỳ: lưu từng khoảng ở phòng cũ/mới và sinh việc dọn đúng phòng cũ", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-05"));
    const alloc = await queryOne<{ id: string }>("SELECT id FROM booking_allocations WHERE booking_id = $1 AND status = 'active'", [b.id]);
    const cr = await requestChange(f.actors.vn_manager, b.id, { kind: "move_unit", allocationId: alloc!.id, toUnitId: f.units.r2, effectiveDate: "2026-10-03" }, { applyNow: true });
    expect(cr.applied).toBe(true);
    const allocs = await query<{ unit_id: string; start_date: string; end_date: string; status: string }>(
      "SELECT unit_id, start_date, end_date, status FROM booking_allocations WHERE booking_id = $1 ORDER BY status, start_date",
      [b.id],
    );
    const active = allocs.filter((a) => a.status === "active");
    expect(active).toEqual([
      { unit_id: f.units.r1, start_date: "2026-10-01", end_date: "2026-10-03", status: "active" },
      { unit_id: f.units.r2, start_date: "2026-10-03", end_date: "2026-10-05", status: "active" },
    ]);
    await runWorker();
    const tasks = (await tasksFor(f.orgId)).filter((t) => t.status !== "cancelled");
    expect(tasks.map((t) => [t.unit_id, t.service_date])).toEqual([
      [f.units.r1, "2026-10-03"],
      [f.units.r2, "2026-10-05"],
    ]);
  });

  it("hủy đã xác nhận giải phóng đúng phần tồn", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput([f.units.r1, f.units.r2], "2026-10-01", "2026-10-03"));
    await requestChange(f.actors.vn_manager, b.id, { kind: "cancel", reason: "Khách hủy trên kênh" }, { applyNow: true });
    expect((await bookingRow(b.id)).booking_status).toBe("cancelled");
    await createBooking(f.actors.vn_staff, bookingInput(f.units.whole, "2026-10-01", "2026-10-03"));
  });

  it("trả phòng muộn bị chặn khi có khách nhận cùng phòng trong ngày", async () => {
    const f = await makeFixture();
    const a = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    const cr1 = await requestChange(f.actors.vn_staff, a.id, { kind: "late_checkout", time: "12:30" });
    expect(cr1.check.ok).toBe(true);
    await createBooking(f.actors.vn_staff, bookingInput(f.units.whole, "2026-10-03", "2026-10-04"));
    const cr2 = await requestChange(f.actors.vn_staff, a.id, { kind: "late_checkout", time: "12:30" });
    expect(cr2.check.issues.map((i) => i.code)).toContain("next_booking_same_day");
    const cr3 = await requestChange(f.actors.vn_staff, a.id, { kind: "late_checkout", time: "14:00" });
    expect(cr3.check.issues.map((i) => i.code)).toContain("too_late");
  });
});
