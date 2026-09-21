import { api } from "@/lib/http";
import { resetUserPassword } from "@/modules/auth/user-admin";

/**
 * POST /api/v1/users/:id/reset-password — quyền users.manage.
 * Trả mật khẩu tạm đúng MỘT lần (không lưu, không ghi nhật ký); phiên đang mở của người đó bị huỷ ngay.
 */
export const POST = api<{ id: string }>(async (_req, actor, params) => resetUserPassword(actor, params.id));
