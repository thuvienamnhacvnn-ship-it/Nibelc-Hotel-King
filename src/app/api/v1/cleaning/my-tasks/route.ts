import { api } from "@/lib/http";
import { forbidden } from "@/lib/errors";
import { can } from "@/modules/auth/actor";
import { myTasks } from "@/modules/cleaning/queries";

/** GET /api/v1/cleaning/my-tasks — việc giao cho người đang đăng nhập. */
export const GET = api(async (_req, actor) => {
  if (!can(actor, "cleaning.own") && !can(actor, "cleaning.view_all")) throw forbidden();
  return myTasks(actor);
});
