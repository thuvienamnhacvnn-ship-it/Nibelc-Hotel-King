import { api, pageParams } from "@/lib/http";
import { listConversations, parseInboxFilters } from "@/modules/inbox/queries";

/** GET /api/v1/inbox/conversations?kind=guest|staff|group&unread=1&waiting=1&channel=whatsapp&page= — quyền inbox.view. */
export const GET = api(async (req, actor) => {
  const url = new URL(req.url);
  return listConversations(actor, parseInboxFilters((k) => url.searchParams.get(k)), pageParams(url, { pageSize: 50, max: 100 }));
});
