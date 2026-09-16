import { api, readJson } from "@/lib/http";
import { cancelHandoff } from "@/modules/inbox/service";

/** POST /api/v1/inbox/handoffs/:id/cancel { reason } — huỷ yêu cầu chuyển người (inbox.takeover). */
export const POST = api<{ id: string }>(async (req, actor, { id }) => cancelHandoff(actor, id, await readJson(req)));
