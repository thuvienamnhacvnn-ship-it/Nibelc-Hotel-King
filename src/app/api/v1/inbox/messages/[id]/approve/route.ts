import { api, readJson } from "@/lib/http";
import { approveDraft } from "@/modules/inbox/service";

/** POST /api/v1/inbox/messages/:id/approve { body? } — duyệt (có thể sửa) nháp bot rồi gửi (inbox.reply). 409 not_draft nếu đã xử lý. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => approveDraft(actor, id, await readJson(req)));
