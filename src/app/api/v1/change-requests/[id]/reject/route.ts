import { api, readJson } from "@/lib/http";
import { rejectChangeRequest } from "@/modules/booking/service";

export const dynamic = "force-dynamic";

/** POST { note: string } — bắt buộc lý do (422 nếu trống). */
export const POST = api<{ id: string }>(async (req, actor, { id }) => {
  const body = (await readJson(req)) as { note?: unknown } | null;
  return rejectChangeRequest(actor, id, typeof body?.note === "string" ? body.note.slice(0, 2000) : "");
});
