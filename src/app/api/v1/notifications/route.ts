import { api, pageParams } from "@/lib/http";
import { can } from "@/modules/auth/actor";
import { listStaffNotifications } from "@/modules/manager/queries";

/**
 * GET /api/v1/notifications?status=queued|sending|sent|failed|suppressed&mine=1
 * Người có automation.pause/reports.view thấy cả hàng đợi của tổ chức; người khác chỉ thấy tin gửi cho mình.
 */
export const GET = api(async (req, actor) => {
  const url = new URL(req.url);
  const all = can(actor, "automation.pause") || can(actor, "reports.view");
  return listStaffNotifications(actor, url.searchParams.get("status"), pageParams(url), { onlyMine: !all || url.searchParams.get("mine") === "1" });
});
