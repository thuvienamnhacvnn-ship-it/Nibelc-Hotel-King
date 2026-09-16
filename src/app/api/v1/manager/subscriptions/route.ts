import { forbidden } from "@/lib/errors";
import { api, readJson } from "@/lib/http";
import { can } from "@/modules/auth/actor";
import { listSubscriptions } from "@/modules/manager/queries";
import { addReportSubscription } from "@/modules/manager/service";

/** GET /api/v1/manager/subscriptions — đăng ký nhận báo cáo. */
export const GET = api(async (_req, actor) => {
  if (!can(actor, "automation.pause") && !can(actor, "reports.view")) throw forbidden();
  const items = await listSubscriptions(actor);
  return { items, page: 1, pageSize: items.length, total: items.length };
});

/** POST /api/v1/manager/subscriptions { userId, kind, channel, sendTime? } — luôn tạo ở trạng thái TẮT. */
export const POST = api(async (req, actor) => addReportSubscription(actor, await readJson(req)));
