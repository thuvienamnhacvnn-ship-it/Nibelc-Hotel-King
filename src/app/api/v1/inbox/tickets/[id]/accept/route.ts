import { api, readJson } from "@/lib/http";
import { acceptTicket } from "@/modules/inbox/service";

/** POST /api/v1/inbox/tickets/:id/accept { expectedVersion } — người được giao (hoặc ai đó khi chưa giao) nhận ticket. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => acceptTicket(actor, id, await readJson(req)));
