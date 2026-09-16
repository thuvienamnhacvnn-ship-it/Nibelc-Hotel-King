import { api, readJson } from "@/lib/http";
import { assertCan, can } from "@/modules/auth/actor";
import { listSwitches } from "@/modules/manager/queries";
import { setAutomationSwitch } from "@/modules/manager/service";

/** GET /api/v1/manager/switches — trạng thái công tắc (chưa có bản ghi = trợ lý/kênh đang dừng). */
export const GET = api(async (_req, actor) => {
  if (!can(actor, "automation.pause")) assertCan(actor, "reports.view");
  const items = await listSwitches(actor);
  return { items, page: 1, pageSize: items.length, total: items.length };
});

/** POST /api/v1/manager/switches { scope: "org"|"agent"|"channel", key, paused, reason } — quyền automation.pause, lý do bắt buộc. */
export const POST = api(async (req, actor) => setAutomationSwitch(actor, await readJson(req)));
