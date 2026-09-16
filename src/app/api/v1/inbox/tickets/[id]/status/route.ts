import { api, readJson } from "@/lib/http";
import { setTicketStatus } from "@/modules/inbox/service";

/** POST /api/v1/inbox/tickets/:id/status { status, expectedVersion, note? } — chuyển trạng thái theo bảng TICKET_TRANSITIONS. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => setTicketStatus(actor, id, await readJson(req)));
