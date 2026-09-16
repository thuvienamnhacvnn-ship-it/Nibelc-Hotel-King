import { api, readJson } from "@/lib/http";
import { retireTemplate } from "@/modules/manager/service";

/** POST /api/v1/manager/templates/:id/retire { reason } — ngừng dùng mẫu. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => retireTemplate(actor, id, await readJson(req)));
