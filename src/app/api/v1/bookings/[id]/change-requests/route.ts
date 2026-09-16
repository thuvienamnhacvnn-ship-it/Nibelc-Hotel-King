import { invalid } from "@/lib/errors";
import { api, readJson } from "@/lib/http";
import { listChangeRequests } from "@/modules/booking/queries";
import { requestChange } from "@/modules/booking/service";

export const dynamic = "force-dynamic";

export const GET = api<{ id: string }>(async (_req, actor, { id }) => ({ items: await listChangeRequests(actor, { bookingId: id, limit: 100 }) }));

/** POST { change: ChangeRequestPayload, note?: string, applyNow?: boolean } */
export const POST = api<{ id: string }>(async (req, actor, { id }) => {
  const body = (await readJson(req)) as { change?: unknown; note?: unknown; applyNow?: unknown } | null;
  if (!body || typeof body !== "object" || !body.change) throw invalid("Thiếu nội dung thay đổi (change).");
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : null;
  return requestChange(actor, id, body.change, { source: "staff", note, applyNow: body.applyNow === true });
});
