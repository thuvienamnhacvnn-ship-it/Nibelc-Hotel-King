import { api, readJson } from "@/lib/http";
import { SESSION_COOKIE } from "@/modules/auth/sessions";
import { changeOwnPassword } from "@/modules/auth/user-admin";

/**
 * POST /api/v1/auth/change-password { currentPassword, newPassword } — mọi người đã đăng nhập.
 * Giữ phiên hiện tại (cookie kèm theo request), huỷ mọi phiên khác của chính người đó.
 */
export const POST = api(async (req, actor) => changeOwnPassword(actor, await readJson(req), req.cookies.get(SESSION_COOKIE)?.value ?? null));
