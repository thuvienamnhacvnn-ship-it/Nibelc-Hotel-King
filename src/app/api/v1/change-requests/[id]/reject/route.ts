import { api, readJson } from "@/lib/http";
import { assertChangeRequestInOrg } from "@/modules/booking/queries";
import { rejectChangeRequest } from "@/modules/booking/service";

export const dynamic = "force-dynamic";

/** POST { note: string } — bắt buộc lý do (422 nếu trống). */
export const POST = api<{ id: string }>(async (req, actor, { id }) => {
  // Id sai dạng hoặc thuộc tổ chức khác → 404 (thống nhất với apply/resolve), trước khi service ghi.
  await assertChangeRequestInOrg(actor, id);
  const body = (await readJson(req)) as { note?: unknown } | null;
  return rejectChangeRequest(actor, id, typeof body?.note === "string" ? body.note.slice(0, 2000) : "");
});
