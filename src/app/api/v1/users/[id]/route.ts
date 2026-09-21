import { api, readJson } from "@/lib/http";
import { updateUser } from "@/modules/auth/user-admin";

/** PATCH /api/v1/users/:id { role?, active? } — quyền users.manage; không tự hạ quyền/khoá chính mình. */
export const PATCH = api<{ id: string }>(async (req, actor, params) => updateUser(actor, params.id, await readJson(req)));
