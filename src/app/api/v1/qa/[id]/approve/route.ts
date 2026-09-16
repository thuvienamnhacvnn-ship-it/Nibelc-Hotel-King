import { api, assertUuid, readJson } from "@/lib/http";
import { approveQaEntry } from "@/modules/qa/service";

/** POST /api/v1/qa/:id/approve { expectedUpdatedAt? } — chờ duyệt → đã duyệt; bản duyệt cũ cùng câu hỏi chuyển ngưng (qa.approve, không tự duyệt) */
export const POST = api<{ id: string }>(async (req, actor, { id }) => approveQaEntry(actor, assertUuid(id), await readJson(req)));
