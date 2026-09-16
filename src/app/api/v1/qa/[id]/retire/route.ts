import { api, assertUuid, readJson } from "@/lib/http";
import { retireQaEntry } from "@/modules/qa/service";

/** POST /api/v1/qa/:id/retire { expectedUpdatedAt?, reason } — ngưng dùng (bản đã duyệt cần qa.approve) */
export const POST = api<{ id: string }>(async (req, actor, { id }) => retireQaEntry(actor, assertUuid(id), await readJson(req)));
