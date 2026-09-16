import { api } from "@/lib/http";
import { retryMessage } from "@/modules/inbox/service";

/** POST /api/v1/inbox/messages/:id/retry — gửi lại tin thất bại (inbox.reply). */
export const POST = api<{ id: string }>(async (_req, actor, { id }) => retryMessage(actor, id));
