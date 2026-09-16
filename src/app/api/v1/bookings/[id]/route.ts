import { api, assertUuid, readJson } from "@/lib/http";
import { getBookingDetail } from "@/modules/booking/queries";
import { updateBookingDetails } from "@/modules/booking/service";

export const dynamic = "force-dynamic";

export const GET = api<{ id: string }>(async (_req, actor, { id }) => getBookingDetail(actor, assertUuid(id, "booking")));

/** PATCH — chỉ sửa thông tin không ảnh hưởng tồn; bắt buộc expectedVersion (409 stale_version nếu cũ). */
export const PATCH = api<{ id: string }>(async (req, actor, { id }) => updateBookingDetails(actor, assertUuid(id, "booking"), await readJson(req)));
