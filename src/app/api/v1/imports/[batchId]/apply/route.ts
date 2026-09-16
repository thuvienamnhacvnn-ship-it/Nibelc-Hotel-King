import { api, readJson } from "@/lib/http";
import { applyImport } from "@/modules/imports/service";

export const dynamic = "force-dynamic";

/** POST { skipCheckOutBefore?: "YYYY-MM-DD" | null } → áp dụng các dòng hợp lệ (quyền import.apply). */
export const POST = api<{ batchId: string }>(async (req, actor, { batchId }) => {
  const body = (await readJson(req)) as { skipCheckOutBefore?: unknown } | null;
  const skip = body && typeof body.skipCheckOutBefore === "string" && body.skipCheckOutBefore ? body.skipCheckOutBefore : null;
  return applyImport(actor, batchId, { skipCheckOutBefore: skip });
});
