import { api } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { catalogOverview } from "@/modules/catalog/queries";

/** GET /api/v1/catalog — nhà, tài nguyên, sản phẩm (kèm resource_ids), listing theo kênh, danh sách cần xác nhận. */
export const GET = api(async (_req, actor) => {
  assertCan(actor, "catalog.view");
  return catalogOverview(actor);
});
