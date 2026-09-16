import { api } from "@/lib/http";
import { todayOps } from "@/lib/time";
import { exportBookingsXlsx } from "@/modules/booking/export";
import { parseBookingFilters } from "@/modules/booking/queries";

export const dynamic = "force-dynamic";

/** GET /api/v1/bookings/export?<cùng bộ lọc với danh sách> → file .xlsx */
export const GET = api(async (req, actor) => {
  const url = new URL(req.url);
  const { buffer } = await exportBookingsXlsx(actor, parseBookingFilters(url.searchParams));
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="booking-${todayOps(actor.timezone)}.xlsx"`,
      "cache-control": "no-store",
    },
  });
});
