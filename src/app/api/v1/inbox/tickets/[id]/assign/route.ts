import { api, readJson } from "@/lib/http";
import { assignTicket } from "@/modules/inbox/service";

/** POST /api/v1/inbox/tickets/:id/assign { assigneeUserId, expectedVersion } — tickets.manage. 409 version_conflict. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => assignTicket(actor, id, await readJson(req)));
