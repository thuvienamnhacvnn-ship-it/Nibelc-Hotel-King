import { api, readJson } from "@/lib/http";
import { applyChangeRequest } from "@/modules/booking/service";

export const dynamic = "force-dynamic";

/** POST { note?: string } — 409 khi kiểm tra lại không đạt (details.issues); { superseded: true } nếu booking đã đổi phiên bản. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => {
  const body = req.headers.get("content-length") === "0" ? null : ((await readJson(req).catch(() => null)) as { note?: unknown } | null);
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : null;
  return applyChangeRequest(actor, id, note);
});
