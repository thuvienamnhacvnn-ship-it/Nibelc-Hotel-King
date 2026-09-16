import { api } from "@/lib/http";
import { acceptHandoff } from "@/modules/inbox/service";

/** POST /api/v1/inbox/handoffs/:id/accept — người nhận bấm nhận; chỉ lúc này handoff mới là accepted (inbox.takeover). */
export const POST = api<{ id: string }>(async (_req, actor, { id }) => acceptHandoff(actor, id));
