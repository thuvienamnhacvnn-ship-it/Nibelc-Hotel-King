import crypto from "node:crypto";
import { query, queryOne, withTx } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { now } from "@/lib/time";
import { writeAudit } from "@/modules/audit/audit";
import { type Actor, userActor } from "./actor";
import { verifyPassword } from "./password";
import { isRole } from "./permissions";

export const SESSION_COOKIE = "nibelc_session";
export const SESSION_TTL_DAYS = 14;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

interface UserRow {
  id: string;
  org_id: string;
  email: string;
  full_name: string;
  role: string;
  password_hash: string;
  active: boolean;
  failed_logins: number;
  locked_until: Date | null;
}

/** Đăng nhập: trả token thô (chỉ nằm trong cookie), DB chỉ lưu mã băm. */
export async function login(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const user = await queryOne<UserRow>(
    "SELECT id, org_id, email, full_name, role, password_hash, active, failed_logins, locked_until FROM users WHERE lower(email) = lower($1)",
    [email.trim()],
  );
  const genericError = new AppError("invalid_credentials", "Email hoặc mật khẩu không đúng.", 401);
  if (!user || !user.active) {
    // Vẫn chạy băm để thời gian phản hồi không lộ email có tồn tại hay không.
    await verifyPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(88));
    throw genericError;
  }
  if (user.locked_until && user.locked_until > now()) {
    throw new AppError("account_locked", `Tài khoản tạm khoá do nhập sai nhiều lần. Thử lại sau ${LOCK_MINUTES} phút.`, 429);
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const failed = user.failed_logins + 1;
    if (failed >= MAX_FAILED) {
      await query("UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1", [user.id, LOCK_MINUTES]);
    } else {
      await query("UPDATE users SET failed_logins = $2 WHERE id = $1", [user.id, failed]);
    }
    await writeAudit(null, { orgId: user.org_id, actorType: "user", actorId: user.id, ip: meta.ip }, "auth.login_failed", "user", user.id, {});
    throw genericError;
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(now().getTime() + SESSION_TTL_DAYS * 86400_000);
  await withTx(async (tx) => {
    await tx.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id]);
    await tx.query(
      "INSERT INTO sessions (token_hash, user_id, org_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5, $6)",
      [sha256(token), user.id, user.org_id, expires, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
    );
    await writeAudit(tx, { orgId: user.org_id, actorType: "user", actorId: user.id, ip: meta.ip }, "auth.login", "user", user.id, {});
  });
  return { token, expires, role: user.role };
}

export async function logout(token: string) {
  await query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

/** Đọc phiên từ token cookie. Trả null nếu hết hạn, bị thu hồi hoặc người dùng bị khoá. */
export async function actorFromToken(token: string | undefined | null, ip?: string | null): Promise<Actor | null> {
  if (!token) return null;
  const row = await queryOne<{
    session_id: string;
    user_id: string;
    org_id: string;
    role: string;
    full_name: string;
    timezone: string;
    last_seen_at: Date;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.org_id, u.role, u.full_name, o.timezone, s.last_seen_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.active
       JOIN organizations o ON o.id = u.org_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!row || !isRole(row.role)) return null;
  // Ghi last_seen tối đa 5 phút/lần để không biến mỗi request thành một lần ghi.
  if (now().getTime() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [row.session_id]);
  }
  return userActor({ userId: row.user_id, orgId: row.org_id, role: row.role, fullName: row.full_name, timezone: row.timezone, ip });
}
