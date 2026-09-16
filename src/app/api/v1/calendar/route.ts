import { api } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { calendarData, parseCalendarParams } from "@/modules/calendar/queries";

/** GET /api/v1/calendar?start=YYYY-MM-DD&days=1|7|14&property=<uuid> */
export const GET = api(async (req, actor) => {
  assertCan(actor, "calendar.view");
  const url = new URL(req.url);
  return calendarData(actor, parseCalendarParams((k) => url.searchParams.get(k), actor.timezone));
});
