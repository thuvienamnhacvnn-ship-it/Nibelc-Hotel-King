import crypto from "node:crypto";
import { z } from "zod";
import { type Queryable, queryOne, withTx } from "@/lib/db";
import { AppError, forbidden, invalid, notFound } from "@/lib/errors";
import { type AuditActor, auditActorOf, writeAudit } from "@/modules/audit/audit";
import { type Actor, assertCan } from "./actor";
import { hashPassword, verifyPassword } from "./password";
import { ROLES, type Role } from "./permissions";

/**
 * Quản trị tài khoản: đặt/đặt lại mật khẩu, đổi vai trò, bật/tắt hoạt động, tự đổi mật khẩu.
 * Quy tắc bất biến ở đây (không chỉ ẩn nút trên giao diện):
 *   - Mọi thao tác lọc org_id của người thực hiện; admin tổ chức A không chạm được người của tổ chức B.
 *   - Đổi mật khẩu = huỷ phiên đang mở của người đó, để mật khẩu cũ mất tác dụng NGAY.
 *   - Mật khẩu thô không bao giờ đi vào audit_log, log hay giá trị trả về nào ngoài đúng một lần cho người đặt.
 *   - Người đang đăng nhập không tự hạ quyền, không tự khoá, không tự "đặt lại" mật khẩu của chính mình
 *     (đổi mật khẩu của mình đi đường changeOwnPassword để không bị đá khỏi phiên đang dùng).
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_RULE = `Mật khẩu cần tối thiểu ${PASSWORD_MIN} ký tự.`;

const passwordSchema = z.string().min(PASSWORD_MIN, PASSWORD_RULE).max(200, "Mật khẩu tối đa 200 ký tự.");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kiểm dữ liệu vào rồi ném AppError("invalid_input") thay vì ZodError thô —
 * script và test gọi thẳng service này chứ không đi qua wrapper api() (nơi ZodError mới được dịch).
 */
function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  throw invalid(
    result.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );
}

// Bảng sessions chỉ lưu mã băm của token (xem sessions.ts) — băm lại để nhận ra phiên đang dùng.
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** Tài khoản đã được cấp mật khẩu chưa. Bản ghi nhập tay còn giữ chuỗi đánh dấu 'chua-cap-mat-khau'. */
export function hasUsablePassword(passwordHash: string | null | undefined): boolean {
  return !!passwordHash && passwordHash.startsWith("scrypt$");
}

/**
 * Mật khẩu tạm: 18 ký tự, bỏ ký tự dễ đọc nhầm (0/O, 1/l/I) và mọi ký tự đặc biệt.
 * Mật khẩu này được đọc lại qua điện thoại và gõ tay — dấu nháy, dấu cách hay ký tự lạ làm hỏng việc đó.
 */
export function generatePassword(length = 18): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

/** Huỷ phiên đang mở của một người (giữ lại phiên có token `keepToken` nếu có). Trả số phiên đã huỷ. */
export async function revokeSessions(client: Queryable, userId: string, keepToken?: string | null): Promise<number> {
  const result = keepToken
    ? await client.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [userId, sha256(keepToken)])
    : await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  return result.rowCount ?? 0;
}

interface UserRow {
  id: string;
  org_id: string;
  email: string;
  full_name: string;
  role: string;
  active: boolean;
  password_hash: string;
  is_demo: boolean;
  org_slug: string;
  org_is_demo: boolean;
}

const USER_COLS = `u.id, u.org_id, u.email, u.full_name, u.role, u.active, u.password_hash, u.is_demo, o.slug AS org_slug, o.is_demo AS org_is_demo`;

async function lockUserInOrg(tx: Queryable, orgId: string, userId: string): Promise<UserRow> {
  // "Kiểm trước rồi ghi": khoá đúng dòng users rồi mới quyết định, thay vì chờ lỗi ràng buộc (bẫy PGlite).
  if (!UUID_RE.test(userId)) throw notFound("người dùng");
  const { rows } = await tx.query<UserRow>(
    `SELECT ${USER_COLS} FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1 AND u.org_id = $2 FOR UPDATE OF u`,
    [userId, orgId],
  );
  if (!rows[0]) throw notFound("người dùng");
  return rows[0];
}

/**
 * Ghi mật khẩu mới + huỷ phiên + ghi nhật ký, trong một giao dịch của người gọi.
 * `detail` không bao giờ chứa mật khẩu — redactSecrets trong writeAudit là lưới an toàn, không phải chỗ dựa.
 */
async function writeNewPassword(
  tx: Queryable,
  user: { id: string; email: string },
  newPassword: string,
  audit: AuditActor,
  action: string,
  detail: Record<string, unknown>,
  keepToken?: string | null,
): Promise<number> {
  const passwordHash = await hashPassword(newPassword);
  await tx.query("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [user.id, passwordHash]);
  const sessionsRevoked = await revokeSessions(tx, user.id, keepToken);
  await writeAudit(tx, audit, action, "user", user.id, { email: user.email, sessionsRevoked, ...detail });
  return sessionsRevoked;
}

// ───────────────────────── Đặt lại mật khẩu (màn hình quản trị) ─────────────────────────

export interface ResetResult {
  userId: string;
  email: string;
  fullName: string;
  /** Mật khẩu tạm — hiện đúng MỘT lần cho người đặt, không lưu và không ghi nhật ký ở đâu. */
  password: string;
  sessionsRevoked: number;
}

/** Đặt lại mật khẩu cho một người trong cùng tổ chức: sinh mật khẩu tạm, trả về đúng một lần. */
export async function resetUserPassword(actor: Actor, userId: string): Promise<ResetResult> {
  assertCan(actor, "users.manage");
  return withTx(async (tx) => {
    const user = await lockUserInOrg(tx, actor.orgId, userId);
    if (user.id === actor.userId) throw forbidden("Mật khẩu của chính bạn đổi ở mục “Tài khoản của tôi” — đặt lại ở đây sẽ đá bạn khỏi phiên đang dùng.");
    const password = generatePassword();
    const sessionsRevoked = await writeNewPassword(tx, user, password, auditActorOf(actor), "user.reset_password", { role: user.role, hadPassword: hasUsablePassword(user.password_hash) });
    return { userId: user.id, email: user.email, fullName: user.full_name, password, sessionsRevoked };
  });
}

// ───────────────────────── Vai trò và trạng thái hoạt động ─────────────────────────

const updateInput = z
  .object({ role: z.enum(ROLES).optional(), active: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.active !== undefined, "Không có thay đổi nào.");

export async function updateUser(actor: Actor, userId: string, raw: unknown) {
  assertCan(actor, "users.manage");
  const input = parseInput(updateInput, raw);
  return withTx(async (tx) => {
    const user = await lockUserInOrg(tx, actor.orgId, userId);
    if (user.id === actor.userId) {
      if (input.role !== undefined && input.role !== user.role) throw forbidden("Không tự đổi vai trò của chính mình — nhờ một quản trị khác đổi giúp.");
      if (input.active === false) throw forbidden("Không tự khoá tài khoản của chính mình.");
    }
    const audit = auditActorOf(actor);
    let sessionsRevoked = 0;
    if (input.role !== undefined && input.role !== user.role) {
      await tx.query("UPDATE users SET role = $2, updated_at = now() WHERE id = $1", [user.id, input.role]);
      await writeAudit(tx, audit, "user.change_role", "user", user.id, { email: user.email, before: user.role, after: input.role });
    }
    if (input.active !== undefined && input.active !== user.active) {
      await tx.query("UPDATE users SET active = $2, updated_at = now() WHERE id = $1", [user.id, input.active]);
      // Khoá tài khoản mà vẫn để phiên sống thì người đó còn dùng được app tới 14 ngày.
      if (!input.active) sessionsRevoked = await revokeSessions(tx, user.id);
      await writeAudit(tx, audit, input.active ? "user.activate" : "user.deactivate", "user", user.id, { email: user.email, sessionsRevoked });
    }
    return { ok: true, sessionsRevoked };
  });
}

// ───────────────────────── Tự đổi mật khẩu ─────────────────────────

const changeOwnInput = z.object({
  currentPassword: z.string().min(1, "Nhập mật khẩu hiện tại.").max(200),
  newPassword: passwordSchema,
});

/**
 * Người đang đăng nhập tự đổi mật khẩu. Bắt buộc nhập mật khẩu cũ.
 * Phiên hiện tại (`currentToken`) được giữ lại; mọi phiên khác bị huỷ.
 */
export async function changeOwnPassword(actor: Actor, raw: unknown, currentToken?: string | null) {
  if (!actor.userId) throw forbidden("Chỉ tài khoản người dùng mới đổi được mật khẩu.");
  const input = parseInput(changeOwnInput, raw);
  if (input.newPassword === input.currentPassword) throw invalid("Mật khẩu mới phải khác mật khẩu hiện tại.");
  // Kiểm mật khẩu cũ NGOÀI giao dịch: lần nhập sai phải để lại dấu vết trong nhật ký,
  // mà ghi trong giao dịch rồi ném lỗi thì ROLLBACK xoá luôn dấu vết đó.
  const user = await queryOne<UserRow>(
    `SELECT ${USER_COLS} FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1 AND u.org_id = $2`,
    [actor.userId, actor.orgId],
  );
  if (!user) throw notFound("người dùng");
  if (!hasUsablePassword(user.password_hash) || !(await verifyPassword(input.currentPassword, user.password_hash))) {
    await writeAudit(null, auditActorOf(actor), "user.change_password_failed", "user", user.id, { email: user.email });
    throw new AppError("wrong_password", "Mật khẩu hiện tại không đúng.", 422);
  }
  return withTx(async (tx) => {
    const sessionsRevoked = await writeNewPassword(tx, user, input.newPassword, auditActorOf(actor), "user.change_password", {}, currentToken);
    return { ok: true, sessionsRevoked };
  });
}

// ───────────────────────── Đặt mật khẩu bằng script (không có phiên đăng nhập) ─────────────────────────

export interface SetPasswordOptions {
  email: string;
  /** Slug tổ chức — bắt buộc khi cần chắc chắn đúng người; email vốn đã duy nhất toàn hệ thống. */
  orgSlug?: string | null;
  password: string;
  allowDemo?: boolean;
  /** Ai chạy script (tên đăng nhập máy). Ghi vào nhật ký để biết ai đã đặt. */
  setBy: string;
}

/**
 * Đặt mật khẩu cho một tài khoản đã có, chạy từ dòng lệnh với tác nhân hệ thống.
 * Từ chối: tài khoản không tồn tại, mật khẩu quá ngắn, tổ chức/tài khoản DEMO (trừ khi allowDemo).
 */
export async function setPasswordForEmail(opts: SetPasswordOptions) {
  const password = parseInput(passwordSchema, opts.password);
  const email = opts.email.trim();
  if (!email) throw invalid("Thiếu email.");
  return withTx(async (tx) => {
    const { rows } = await tx.query<UserRow>(
      `SELECT ${USER_COLS} FROM users u JOIN organizations o ON o.id = u.org_id
        WHERE lower(u.email) = lower($1) AND ($2::text IS NULL OR o.slug = $2) FOR UPDATE OF u`,
      [email, opts.orgSlug ?? null],
    );
    const user = rows[0];
    if (!user) throw notFound(opts.orgSlug ? `tài khoản ${email} trong tổ chức ${opts.orgSlug}` : `tài khoản ${email}`);
    if ((user.is_demo || user.org_is_demo) && !opts.allowDemo) {
      throw invalid(`Tài khoản thuộc tổ chức DEMO (${user.org_slug}). Thêm --allow-demo nếu thật sự muốn đặt.`);
    }
    const audit: AuditActor = { orgId: user.org_id, actorType: "system", actorId: null, ip: null };
    const sessionsRevoked = await writeNewPassword(tx, user, password, audit, "user.set_password", {
      role: user.role,
      hadPassword: hasUsablePassword(user.password_hash),
      setBy: opts.setBy,
      via: "scripts/set-password.ts",
    });
    return { userId: user.id, email: user.email, fullName: user.full_name, role: user.role as Role, orgSlug: user.org_slug, isDemo: user.is_demo || user.org_is_demo, sessionsRevoked };
  });
}
