import { api, assertUuid, readJson } from "@/lib/http";
import { reviseQaEntry } from "@/modules/qa/service";

/** POST /api/v1/qa/:id/revise { expectedUpdatedAt?, content } — bản đã duyệt/ngưng → phiên bản mới ở trạng thái nháp (qa.edit) */
export const POST = api<{ id: string }>(async (req, actor, { id }) => reviseQaEntry(actor, assertUuid(id), await readJson(req)));
