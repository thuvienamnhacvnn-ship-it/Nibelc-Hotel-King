import { api } from "@/lib/http";
import { listUsers } from "@/modules/auth/user-queries";

/** GET /api/v1/users — người dùng trong tổ chức của phiên. Quyền users.manage (kiểm trong listUsers). */
export const GET = api(async (_req, actor) => {
  const items = await listUsers(actor);
  return { items, page: 1, pageSize: items.length, total: items.length };
});
