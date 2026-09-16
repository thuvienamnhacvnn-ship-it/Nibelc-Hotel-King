import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { redactSecrets } from "@/modules/audit/audit";
import { hashPassword, verifyPassword } from "@/modules/auth/password";
import { actorFromToken, login } from "@/modules/auth/sessions";
import { applyChangeRequest, createBooking, requestChange, updateBookingDetails } from "@/modules/booking/service";
import { assignTask } from "@/modules/cleaning/service";
import { bookingInput, expectCode, makeFixture, runWorker, tasksFor, uid } from "./helpers";

describe("Phân quyền và cách ly tổ chức", () => {
  it("người của tổ chức khác không đọc/sửa được booking", async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const booking = await createBooking(a.actors.vn_staff, bookingInput(a.units.r1, "2026-10-01", "2026-10-03"));
    await expectCode(updateBookingDetails(b.actors.admin, booking.id, { expectedVersion: 2, opsNote: "x" }), "not_found");
    await expectCode(requestChange(b.actors.admin, booking.id, { kind: "cancel", reason: "thử cách ly" }), "not_found");
    // Không dùng được sản phẩm của tổ chức khác
    await expectCode(createBooking(b.actors.admin, bookingInput(a.units.r2, "2026-10-01", "2026-10-03")), "not_found");
    await runWorker();
    const task = (await tasksFor(a.orgId))[0];
    await expectCode(assignTask(b.actors.admin, task.id, { userId: a.cleaners[0].userId! }), "not_found");
    // Không giao việc cho cleaner của tổ chức khác
    await expectCode(assignTask(a.actors.bp_coordinator, task.id, { userId: b.cleaners[0].userId! }), "invalid_input");
  });

  it("ma trận quyền cơ bản", async () => {
    const f = await makeFixture();
    await expectCode(createBooking(f.actors.cleaner, bookingInput(f.units.r1, "2026-10-01", "2026-10-03")), "forbidden");
    await expectCode(createBooking(f.actors.manager_viewer, bookingInput(f.units.r1, "2026-10-01", "2026-10-03")), "forbidden");
    // Người không xem doanh thu không nhập được số tiền
    await expectCode(createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03", { totalAmount: "120.50" })), "forbidden");
    const b = await createBooking(f.actors.vn_manager, bookingInput(f.units.r1, "2026-10-01", "2026-10-03", { totalAmount: "120.50" }));
    const amount = await query<{ total_amount_minor: number }>("SELECT total_amount_minor FROM bookings WHERE id = $1", [b.id]);
    expect(amount[0].total_amount_minor).toBe(12050);
    const cr = await requestChange(f.actors.bp_coordinator, b.id, { kind: "guests", adults: 1, children: 0 });
    await expectCode(applyChangeRequest(f.actors.bp_coordinator, cr.id), "forbidden");
  });

  it("đăng nhập: sai 5 lần thì khoá tạm; token phiên chỉ lưu mã băm", async () => {
    const f = await makeFixture();
    const email = `login-${uid()}@test.local`;
    await query("INSERT INTO users (org_id, email, full_name, role, password_hash) VALUES ($1,$2,'Login','vn_staff',$3)", [f.orgId, email, await hashPassword("mat-khau-dung-123")]);
    const ok = await login(email, "mat-khau-dung-123", {});
    const actor = await actorFromToken(ok.token);
    expect(actor?.role).toBe("vn_staff");
    const stored = await query<{ token_hash: string }>("SELECT token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1", [email]);
    expect(stored[0].token_hash).not.toBe(ok.token);
    for (let i = 0; i < 5; i++) await expectCode(login(email, "sai", {}), "invalid_credentials");
    await expectCode(login(email, "mat-khau-dung-123", {}), "account_locked");
    expect(await actorFromToken("token-bia")).toBeNull();
  });

  it("băm mật khẩu và ẩn bí mật trong nhật ký", async () => {
    const h = await hashPassword("mot-mat-khau-dai");
    expect(await verifyPassword("mot-mat-khau-dai", h)).toBe(true);
    expect(await verifyPassword("khac", h)).toBe(false);
    expect(redactSecrets({ note: "ok", password: "x", nested: { doorCode: "1234", apiKey: "k" } })).toEqual({
      note: "ok",
      password: "[đã ẩn]",
      nested: { doorCode: "[đã ẩn]", apiKey: "[đã ẩn]" },
    });
  });
});
