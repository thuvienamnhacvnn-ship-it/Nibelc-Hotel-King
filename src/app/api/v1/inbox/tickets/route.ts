import { api, readJson } from "@/lib/http";
import { createTicket } from "@/modules/inbox/service";

/** POST /api/v1/inbox/tickets { conversationId?, category, priority?, summary, detail?, assigneeUserId? } — tickets.manage. P0/P1 nhận trong 5 phút, P2 trong 15 phút. */
export const POST = api(async (req, actor) => createTicket(actor, await readJson(req)));
