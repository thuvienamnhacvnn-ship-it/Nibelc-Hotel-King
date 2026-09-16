import { api } from "@/lib/http";
import { releaseToBot } from "@/modules/inbox/service";

/** POST /api/v1/inbox/conversations/:id/release — trả hội thoại khách cho bot (inbox.takeover). */
export const POST = api<{ id: string }>(async (_req, actor, { id }) => releaseToBot(actor, id));
