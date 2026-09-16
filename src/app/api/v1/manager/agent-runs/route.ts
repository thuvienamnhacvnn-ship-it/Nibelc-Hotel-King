import { forbidden } from "@/lib/errors";
import { api, pageParams } from "@/lib/http";
import { can } from "@/modules/auth/actor";
import { listAgentRuns } from "@/modules/manager/queries";

/** GET /api/v1/manager/agent-runs?status= — lượt chạy trợ lý. */
export const GET = api(async (req, actor) => {
  if (!can(actor, "automation.pause") && !can(actor, "reports.view")) throw forbidden();
  const url = new URL(req.url);
  return listAgentRuns(actor, url.searchParams.get("status"), pageParams(url));
});
