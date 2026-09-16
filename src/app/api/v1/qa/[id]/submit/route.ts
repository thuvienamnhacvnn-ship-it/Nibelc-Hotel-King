import { api, assertUuid, readJson } from "@/lib/http";
import { submitQaForReview } from "@/modules/qa/service";

/** POST /api/v1/qa/:id/submit { expectedUpdatedAt? } — nháp → chờ duyệt (qa.edit) */
export const POST = api<{ id: string }>(async (req, actor, { id }) => submitQaForReview(actor, assertUuid(id), await readJson(req)));
