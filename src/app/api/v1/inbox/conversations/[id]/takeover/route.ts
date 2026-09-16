import { api } from "@/lib/http";
import { takeOverConversation } from "@/modules/inbox/service";

/** POST /api/v1/inbox/conversations/:id/takeover — người tiếp quản, bot im lặng (inbox.takeover). */
export const POST = api<{ id: string }>(async (_req, actor, { id }) => takeOverConversation(actor, id));
