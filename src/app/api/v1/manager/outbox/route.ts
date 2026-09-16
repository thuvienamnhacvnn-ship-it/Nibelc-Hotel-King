import { forbidden } from "@/lib/errors";
import { api, pageParams } from "@/lib/http";
import { can } from "@/modules/auth/actor";
import { listOutbox } from "@/modules/manager/queries";

/** GET /api/v1/manager/outbox?status=dead|pending|processing — sự kiện nền chưa xong. */
export const GET = api(async (req, actor) => {
  if (!can(actor, "automation.pause") && !can(actor, "reports.view")) throw forbidden();
  const url = new URL(req.url);
  return listOutbox(actor, url.searchParams.get("status"), pageParams(url));
});
