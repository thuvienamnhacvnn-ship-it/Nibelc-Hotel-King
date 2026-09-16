import { api } from "@/lib/http";
import { listChangeRequests } from "@/modules/booking/queries";

export const dynamic = "force-dynamic";

/** GET /api/v1/change-requests?status=pending|applied|rejected|superseded|failed */
export const GET = api(async (req, actor) => {
  const status = new URL(req.url).searchParams.get("status");
  return { items: await listChangeRequests(actor, { status: status || null }) };
});
