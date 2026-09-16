import { api, pageParams } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { listInboundEvents } from "@/modules/connectors/queries";

/** GET /api/v1/connectors/events?connectorId=&status=&page=&pageSize= — nhật ký sự kiện nhận, kèm hai mốc độ trễ. */
export const GET = api(async (req, actor) => {
  assertCan(actor, "connector.view");
  const url = new URL(req.url);
  return listInboundEvents(actor, { connectorId: url.searchParams.get("connectorId"), status: url.searchParams.get("status") }, pageParams(url, { pageSize: 25, max: 200 }));
});
