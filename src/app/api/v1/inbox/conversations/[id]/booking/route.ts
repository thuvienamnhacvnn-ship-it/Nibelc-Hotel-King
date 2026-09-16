import { api, readJson } from "@/lib/http";
import { attachBooking } from "@/modules/inbox/service";

/** POST /api/v1/inbox/conversations/:id/booking { bookingId: uuid | null } — gắn/bỏ gắn booking thủ công (inbox.reply + booking.view). */
export const POST = api<{ id: string }>(async (req, actor, { id }) => attachBooking(actor, id, await readJson(req)));
