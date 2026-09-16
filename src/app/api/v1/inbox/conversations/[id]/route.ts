import { api } from "@/lib/http";
import { notFound } from "@/lib/errors";
import { getConversationDetail } from "@/modules/inbox/queries";

/** GET /api/v1/inbox/conversations/:id — hội thoại + 200 tin gần nhất + ticket + handoff. Quyền inbox.view. */
export const GET = api<{ id: string }>(async (_req, actor, { id }) => {
  const detail = await getConversationDetail(actor, id);
  if (!detail) throw notFound("hội thoại");
  return detail;
});
