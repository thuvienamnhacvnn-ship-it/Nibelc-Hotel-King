import { api } from "@/lib/http";
import { approveTemplate } from "@/modules/manager/service";

/** POST /api/v1/manager/templates/:id/approve — quyền templates.approve; người soạn không tự duyệt (403). */
export const POST = api<{ id: string }>(async (_req, actor, { id }) => approveTemplate(actor, id));
