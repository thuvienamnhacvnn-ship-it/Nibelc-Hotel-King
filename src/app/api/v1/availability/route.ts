import { api } from "@/lib/http";
import { checkAvailability } from "@/modules/booking/queries";

export const dynamic = "force-dynamic";

/** GET /api/v1/availability?unitId&start&end[&excludeBookingId] → { available, conflicts[] } (chỉ đọc, không giữ chỗ) */
export const GET = api(async (req, actor) => {
  const p = new URL(req.url).searchParams;
  return checkAvailability(actor, { unitId: p.get("unitId"), start: p.get("start"), end: p.get("end"), excludeBookingId: p.get("excludeBookingId") });
});
