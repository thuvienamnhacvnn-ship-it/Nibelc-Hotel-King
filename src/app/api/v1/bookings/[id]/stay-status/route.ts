import { invalid } from "@/lib/errors";
import { api, assertUuid, readJson } from "@/lib/http";
import { setStayStatus } from "@/modules/booking/service";

export const dynamic = "force-dynamic";

/** POST { status: "checked_in"|"checked_out"|"no_show"|"expected", expectedVersion: number, at?: ISO string } */
export const POST = api<{ id: string }>(async (req, actor, { id }) => {
  assertUuid(id, "booking");
  const body = (await readJson(req)) as { status?: unknown; expectedVersion?: unknown; at?: unknown } | null;
  if (typeof body?.status !== "string") throw invalid("Thiếu trạng thái lưu trú.");
  if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion)) throw invalid("Thiếu expectedVersion.");
  return setStayStatus(actor, id, { status: body.status, expectedVersion: body.expectedVersion, at: typeof body.at === "string" ? body.at : null });
});
