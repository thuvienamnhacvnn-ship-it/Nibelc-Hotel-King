import { api } from "@/lib/http";
import { invalid } from "@/lib/errors";
import { isValidDate, todayOps } from "@/lib/time";
import { listTasksForDay } from "@/modules/cleaning/queries";

/** GET /api/v1/cleaning/tasks?date=YYYY-MM-DD&status=&propertyId= — việc dọn của một ngày vận hành (cần cleaning.view_all). */
export const GET = api(async (req, actor) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayOps(actor.timezone);
  if (!isValidDate(date)) throw invalid("Ngày không hợp lệ (định dạng YYYY-MM-DD).");
  const items = await listTasksForDay(actor, { date, status: url.searchParams.get("status"), propertyId: url.searchParams.get("propertyId") });
  return { date, items, page: 1, pageSize: items.length, total: items.length };
});
