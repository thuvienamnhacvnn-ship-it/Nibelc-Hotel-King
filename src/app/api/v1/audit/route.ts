import { api, pageParams } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { listAudit } from "@/modules/audit/queries";

/** GET /api/v1/audit?entityType=&action=&actor=<uuid|system:connector>&from=YYYY-MM-DD&to=YYYY-MM-DD&page=&pageSize= (ngày theo giờ Budapest) */
export const GET = api(async (req, actor) => {
  assertCan(actor, "audit.view");
  const url = new URL(req.url);
  const g = (k: string) => url.searchParams.get(k);
  return listAudit(actor, { entityType: g("entityType"), action: g("action"), actor: g("actor"), from: g("from"), to: g("to") }, pageParams(url, { pageSize: 50, max: 200 }));
});
