import { api } from "@/lib/http";
import { searchBookingsByRef } from "@/modules/inbox/queries";

/** GET /api/v1/inbox/bookings?ref=ABC — tìm booking theo mã để gắn vào hội thoại (booking.view). Tối đa 10 kết quả. */
export const GET = api(async (req, actor) => {
  const items = await searchBookingsByRef(actor, new URL(req.url).searchParams.get("ref") ?? "");
  return { items, page: 1, pageSize: items.length, total: items.length };
});
