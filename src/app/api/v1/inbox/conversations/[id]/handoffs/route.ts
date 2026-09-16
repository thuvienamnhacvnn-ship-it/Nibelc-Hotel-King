import { api, readJson } from "@/lib/http";
import { requestHandoff } from "@/modules/inbox/service";

/** POST /api/v1/inbox/conversations/:id/handoffs { reason, targetUserId?, category?, priority? } — yêu cầu chuyển người (inbox.reply). 409 nếu đã có yêu cầu đang chờ. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => requestHandoff(actor, id, await readJson(req)));
