import { query } from "@/lib/db";
import { type Actor, assertCan } from "./actor";
import type { Role } from "./permissions";

/** Truy vấn đọc cho màn hình /nguoi-dung. Chỉ người có users.manage được gọi, và chỉ thấy tổ chức của mình. */

export interface UserListRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  phone: string | null;
  duties: string[];
  active: boolean;
  is_demo: boolean;
  has_password: boolean;
  locked_until: Date | null;
  last_login_at: Date | null;
  active_sessions: number;
  created_at: Date;
}

/**
 * Danh sách người dùng của tổ chức.
 * `has_password`: tài khoản nhập tay còn giữ chuỗi đánh dấu 'chua-cap-mat-khau' — chưa đăng nhập được.
 * `last_login_at`: users không có cột này; lấy từ nhật ký (auth.login) — nhật ký bị dọn thì hiện "—", không bịa số.
 */
export async function listUsers(actor: Actor): Promise<UserListRow[]> {
  assertCan(actor, "users.manage");
  return query<UserListRow>(
    `SELECT u.id, u.email, u.full_name, u.role, u.phone, u.duties, u.active, u.is_demo, u.locked_until, u.created_at,
            left(u.password_hash, 7) = 'scrypt$' AS has_password,
            (SELECT max(a.created_at) FROM audit_log a
              WHERE a.org_id = u.org_id AND a.entity_type = 'user' AND a.entity_id = u.id::text AND a.action = 'auth.login') AS last_login_at,
            (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions
       FROM users u
      WHERE u.org_id = $1
      ORDER BY u.active DESC, u.full_name`,
    [actor.orgId],
  );
}
