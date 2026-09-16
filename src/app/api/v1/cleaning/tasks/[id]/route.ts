import { api } from "@/lib/http";
import { getTaskDetail } from "@/modules/cleaning/queries";

/** GET /api/v1/cleaning/tasks/:id — cleaner chỉ mở được việc giao cho mình (việc người khác trả 404). */
export const GET = api<{ id: string }>(async (_req, actor, { id }) => getTaskDetail(actor, id));
