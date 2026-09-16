import { api, assertUuid, readJson } from "@/lib/http";
import { resolveConflict } from "@/modules/booking/service";

export const dynamic = "force-dynamic";

/** POST { resolution: string } — ghi chú cách đã xử lý (422 nếu trống). Không tự hủy booking nào. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => {
  assertUuid(id, "xung đột");
  const body = (await readJson(req)) as { resolution?: unknown } | null;
  return resolveConflict(actor, id, typeof body?.resolution === "string" ? body.resolution.slice(0, 2000) : "");
});
