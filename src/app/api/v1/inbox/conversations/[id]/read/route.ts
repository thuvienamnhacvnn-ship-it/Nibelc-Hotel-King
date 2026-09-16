import { api } from "@/lib/http";
import { markConversationRead } from "@/modules/inbox/service";

/** POST /api/v1/inbox/conversations/:id/read — đánh dấu đã đọc (inbox.view). */
export const POST = api<{ id: string }>(async (_req, actor, { id }) => markConversationRead(actor, id));
