import { api } from "@/lib/http";
import { discardDraft } from "@/modules/inbox/service";

/** POST /api/v1/inbox/messages/:id/discard — huỷ nháp (inbox.reply). */
export const POST = api<{ id: string }>(async (_req, actor, { id }) => discardDraft(actor, id));
