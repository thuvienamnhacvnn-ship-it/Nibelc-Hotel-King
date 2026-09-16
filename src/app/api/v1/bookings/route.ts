import { api, pageParams, readJson } from "@/lib/http";
import { listBookings, parseBookingFilters } from "@/modules/booking/queries";
import { createBooking } from "@/modules/booking/service";

export const dynamic = "force-dynamic";

/** GET /api/v1/bookings?from&to&property&unit&channel&status&stay&pending=1&conflict=1&q&sort&page&pageSize */
export const GET = api(async (req, actor) => {
  const url = new URL(req.url);
  return listBookings(actor, parseBookingFilters(url.searchParams), pageParams(url));
});

/** POST /api/v1/bookings — body theo createBookingInput. 409 inventory_conflict kèm details.conflicts. */
export const POST = api(async (req, actor) => createBooking(actor, await readJson(req)));
