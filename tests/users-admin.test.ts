import { describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { hashPassword } from "@/modules/auth/password";
import { actorFromToken, login } from "@/modules/auth/sessions";
import { changeOwnPassword, generatePassword, resetUserPassword, setPasswordForEmail, updateUser } from "@/modules/auth/user-admin";
import { listUsers } from "@/modules/auth/user-queries";
import { expectCode, makeFixture, uid } from "./helpers";

/** Tạo thêm một người dùng thật (không DEMO) trong tổ chức của fixture. */
async function addUser(orgId: string, role = "vn_staff", password: string | null = null) {
  const email = `u-${uid()}@test.local`;
  const row = await queryOne<{ id: string }>(
    "INSERT INTO users (org_id, email, full_name, role, password_hash, phone) VALUES ($1,$2,$3,$4,$5,'+36 70 000 0000') RETURNING id",
    [orgId, email, `Người ${email.slice(2, 8)}`, role, password ? await hashPassword(password) : "chua-cap-mat-khau"],
  );
  return { id: row!.id, email };
}

describe("Quản trị người dùng", () => {
  it("chỉ users.manage mới xem/sửa được; các vai trò khác bị chặn", async () => {
    const f = await makeFixture();
    const target = await addUser(f.orgId);
    for (const role of ["vn_manager", "bp_coordinator", "vn_staff", "manager_viewer", "cleaner"] as const) {
      await expectCode(listUsers(f.actors[role]), "forbidden");
      await expectCode(resetUserPassword(f.actors[role], target.id), "forbidden");
      await expectCode(updateUser(f.actors[role], target.id, { active: false }), "forbidden");
    }
    // Leader duyệt được mọi nghiệp vụ nhưng KHÔNG quản trị tài khoản (xem permissions.ts).
    const leaderRow = await queryOne<{ id: string }>("INSERT INTO users (org_id, email, full_name, role, password_hash) VALUES ($1,$2,'Leader','leader','x') RETURNING id", [
      f.orgId,
      `leader-${uid()}@test.local`,
    ]);
    const { userActor } = await import("@/modules/auth/actor");
    const leader = userActor({ userId: leaderRow!.id, orgId: f.orgId, role: "leader", fullName: "Leader", timezone: "Europe/Budapest" });
    await expectCode(listUsers(leader), "forbidden");
    expect((await listUsers(f.actors.admin)).some((u) => u.id === target.id)).toBe(true);
  });

  it("danh sách nêu đúng ai chưa có mật khẩu và lần đăng nhập gần nhất", async () => {
    const f = await makeFixture();
    const chua = await addUser(f.orgId);
    const roi = await addUser(f.orgId, "vn_staff", "mat-khau-cu-12345");
    let rows = await listUsers(f.actors.admin);
    expect(rows.find((u) => u.id === chua.id)?.has_password).toBe(false);
    expect(rows.find((u) => u.id === roi.id)?.has_password).toBe(true);
    expect(rows.find((u) => u.id === roi.id)?.last_login_at).toBeNull();
    await login(roi.email, "mat-khau-cu-12345", {});
    rows = await listUsers(f.actors.admin);
    expect(rows.find((u) => u.id === roi.id)?.last_login_at).toBeInstanceOf(Date);
    expect(rows.find((u) => u.id === roi.id)?.active_sessions).toBe(1);
  });

  it("đặt lại mật khẩu: mật khẩu mới dùng được, mật khẩu cũ hỏng, phiên cũ bị huỷ", async () => {
    const f = await makeFixture();
    const target = await addUser(f.orgId, "vn_staff", "mat-khau-cu-12345");
    const old = await login(target.email, "mat-khau-cu-12345", {});
    expect(await actorFromToken(old.token)).not.toBeNull();

    const reset = await resetUserPassword(f.actors.admin, target.id);
    expect(reset.password.length).toBeGreaterThanOrEqual(12);
    expect(reset.sessionsRevoked).toBe(1);
    // Phiên cũ chết ngay, mật khẩu cũ không còn đăng nhập được, mật khẩu tạm thì được.
    expect(await actorFromToken(old.token)).toBeNull();
    await expectCode(login(target.email, "mat-khau-cu-12345", {}), "invalid_credentials");
    const fresh = await login(target.email, reset.password, {});
    expect((await actorFromToken(fresh.token))?.userId).toBe(target.id);

    // Nhật ký ghi việc đặt lại nhưng KHÔNG chứa mật khẩu ở bất kỳ dạng nào.
    const audit = await query<{ action: string; detail: Record<string, unknown> }>(
      "SELECT action, detail FROM audit_log WHERE org_id = $1 AND entity_type = 'user' AND entity_id = $2 AND action = 'user.reset_password'",
      [f.orgId, target.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].detail.email).toBe(target.email);
    expect(JSON.stringify(audit[0].detail)).not.toContain(reset.password);
  });

  it("không tự hạ quyền, tự khoá hay tự đặt lại mật khẩu chính mình", async () => {
    const f = await makeFixture();
    const me = f.actors.admin.userId!;
    await expectCode(updateUser(f.actors.admin, me, { role: "vn_staff" }), "forbidden");
    await expectCode(updateUser(f.actors.admin, me, { active: false }), "forbidden");
    await expectCode(resetUserPassword(f.actors.admin, me), "forbidden");
    const row = await queryOne<{ role: string; active: boolean }>("SELECT role, active FROM users WHERE id = $1", [me]);
    expect(row).toEqual({ role: "admin", active: true });
  });

  it("đổi vai trò và khoá người khác được; khoá thì phiên của họ bị huỷ", async () => {
    const f = await makeFixture();
    const target = await addUser(f.orgId, "vn_staff", "mat-khau-cu-12345");
    const session = await login(target.email, "mat-khau-cu-12345", {});
    await updateUser(f.actors.admin, target.id, { role: "bp_coordinator" });
    const after = (await listUsers(f.actors.admin)).find((u) => u.id === target.id);
    expect(after?.role).toBe("bp_coordinator");

    const locked = await updateUser(f.actors.admin, target.id, { active: false });
    expect(locked.sessionsRevoked).toBe(1);
    expect(await actorFromToken(session.token)).toBeNull();
    await expectCode(login(target.email, "mat-khau-cu-12345", {}), "invalid_credentials");
    // Mở lại thì mật khẩu cũ dùng được tiếp (không bị xoá).
    await updateUser(f.actors.admin, target.id, { active: true });
    expect((await login(target.email, "mat-khau-cu-12345", {})).role).toBe("bp_coordinator");
    const actions = await query<{ action: string }>("SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'user.%' ORDER BY id", [target.id]);
    expect(actions.map((a) => a.action)).toEqual(["user.change_role", "user.deactivate", "user.activate"]);
  });

  it("cách ly tổ chức: quản trị A không thấy và không sửa được người của tổ chức B", async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const targetB = await addUser(b.orgId, "vn_staff", "mat-khau-cu-12345");
    const listA = await listUsers(a.actors.admin);
    expect(listA.some((u) => u.id === targetB.id)).toBe(false);
    expect(listA.every((u) => u.email.endsWith("@test.local"))).toBe(true);
    await expectCode(resetUserPassword(a.actors.admin, targetB.id), "not_found");
    await expectCode(updateUser(a.actors.admin, targetB.id, { role: "cleaner" }), "not_found");
    await expectCode(updateUser(a.actors.admin, targetB.id, { active: false }), "not_found");
    // Không đụng được thì mật khẩu và vai trò của người bên B còn nguyên.
    expect((await login(targetB.email, "mat-khau-cu-12345", {})).role).toBe("vn_staff");
  });

  it("tự đổi mật khẩu: sai mật khẩu cũ bị từ chối, đổi xong phiên khác bị huỷ còn phiên hiện tại giữ nguyên", async () => {
    const f = await makeFixture();
    const target = await addUser(f.orgId, "vn_staff", "mat-khau-cu-12345");
    const { userActor } = await import("@/modules/auth/actor");
    const me = userActor({ userId: target.id, orgId: f.orgId, role: "vn_staff", fullName: "Người thử", timezone: "Europe/Budapest" });
    const dienThoai = await login(target.email, "mat-khau-cu-12345", {});
    const mayTinh = await login(target.email, "mat-khau-cu-12345", {});

    await expectCode(changeOwnPassword(me, { currentPassword: "sai-mat-khau", newPassword: "mat-khau-moi-67890" }, mayTinh.token), "wrong_password");
    await expectCode(changeOwnPassword(me, { currentPassword: "mat-khau-cu-12345", newPassword: "ngan" }, mayTinh.token), "invalid_input");
    await expectCode(changeOwnPassword(me, { currentPassword: "mat-khau-cu-12345", newPassword: "mat-khau-cu-12345" }, mayTinh.token), "invalid_input");
    // Nhập sai vẫn phải để lại dấu vết trong nhật ký (không bị ROLLBACK cuốn đi).
    const failed = await query("SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'user.change_password_failed'", [target.id]);
    expect(failed).toHaveLength(1);

    const res = await changeOwnPassword(me, { currentPassword: "mat-khau-cu-12345", newPassword: "mat-khau-moi-67890" }, mayTinh.token);
    expect(res.sessionsRevoked).toBe(1);
    expect(await actorFromToken(mayTinh.token)).not.toBeNull();
    expect(await actorFromToken(dienThoai.token)).toBeNull();
    await expectCode(login(target.email, "mat-khau-cu-12345", {}), "invalid_credentials");
    expect((await login(target.email, "mat-khau-moi-67890", {})).role).toBe("vn_staff");
  });

  it("script set-password: từ chối email lạ, mật khẩu ngắn và tổ chức DEMO khi chưa có --allow-demo", async () => {
    const f = await makeFixture();
    const target = await addUser(f.orgId);
    const org = await queryOne<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [f.orgId]);
    const setBy = "test@ci";

    await expectCode(setPasswordForEmail({ email: `khong-co-${uid()}@test.local`, password: "mat-khau-dai-123", setBy }), "not_found");
    await expectCode(setPasswordForEmail({ email: target.email, password: "ngan", setBy }), "invalid_input");
    // makeFixture tạo tổ chức DEMO nên đây đúng là hàng rào cần kiểm.
    await expectCode(setPasswordForEmail({ email: target.email, password: "mat-khau-dai-123", setBy }), "invalid_input");
    // Sai slug tổ chức cũng không tìm thấy, dù email đúng.
    await expectCode(setPasswordForEmail({ email: target.email, orgSlug: `khac-${uid()}`, password: "mat-khau-dai-123", allowDemo: true, setBy }), "not_found");

    const password = generatePassword();
    const result = await setPasswordForEmail({ email: target.email.toUpperCase(), orgSlug: org!.slug, password, allowDemo: true, setBy });
    expect(result.userId).toBe(target.id);
    expect((await login(target.email, password, {})).role).toBe("vn_staff");

    const audit = await queryOne<{ actor_type: string; actor_id: string | null; detail: Record<string, unknown> }>(
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE entity_id = $1 AND action = 'user.set_password'",
      [target.id],
    );
    expect(audit?.actor_type).toBe("system");
    expect(audit?.actor_id).toBeNull();
    expect(audit?.detail.email).toBe(target.email);
    expect(audit?.detail.setBy).toBe(setBy);
    expect(JSON.stringify(audit?.detail)).not.toContain(password);
  });

  it("mật khẩu sinh tự động đủ dài, không trùng nhau và không có ký tự dễ gõ nhầm", async () => {
    const many = Array.from({ length: 50 }, () => generatePassword());
    expect(new Set(many).size).toBe(50);
    for (const p of many) {
      expect(p).toHaveLength(18);
      expect(p).toMatch(/^[a-zA-Z2-9]+$/);
      expect(p).not.toMatch(/[lIoO01]/);
    }
  });
});
