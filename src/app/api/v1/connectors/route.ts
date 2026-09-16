import { api } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { listConnectors } from "@/modules/connectors/queries";

/** GET /api/v1/connectors — danh sách connector (trạng thái 5 mức, năng lực, lần thử/thành công, lỗi, tạm dừng). */
export const GET = api(async (_req, actor) => {
  assertCan(actor, "connector.view");
  const items = await listConnectors(actor);
  return { items, page: 1, pageSize: items.length, total: items.length };
});
