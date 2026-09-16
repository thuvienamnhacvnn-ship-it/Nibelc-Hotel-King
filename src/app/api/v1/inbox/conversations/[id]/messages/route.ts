import { api, readJson } from "@/lib/http";
import { replyToConversation } from "@/modules/inbox/service";

/** POST /api/v1/inbox/conversations/:id/messages { body } — trả lời thủ công (inbox.reply). Trả { messageId, status: sent|failed|queued, error }. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => replyToConversation(actor, id, await readJson(req)));
