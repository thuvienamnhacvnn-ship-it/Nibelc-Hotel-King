import { api, assertUuid, readJson } from "@/lib/http";
import { rejectQaEntry } from "@/modules/qa/service";

/** POST /api/v1/qa/:id/reject { expectedUpdatedAt?, reason } — chờ duyệt → nháp (qa.approve) */
export const POST = api<{ id: string }>(async (req, actor, { id }) => rejectQaEntry(actor, assertUuid(id), await readJson(req)));
