import { api, readJson } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { listReports } from "@/modules/manager/queries";
import { generateReport } from "@/modules/manager/service";

/** GET /api/v1/manager/reports — 30 báo cáo gần nhất (quyền reports.view). */
export const GET = api(async (_req, actor) => {
  assertCan(actor, "reports.view");
  const items = await listReports(actor, 30);
  return { items, page: 1, pageSize: 30, total: items.length };
});

/** POST /api/v1/manager/reports { opsDate: "YYYY-MM-DD", kind: "morning"|"evening" } → { id, cutoffAt }. Lưu bản nháp, không gửi. */
export const POST = api(async (req, actor) => generateReport(actor, await readJson(req)));
