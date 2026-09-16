import { notFound } from "@/lib/errors";
import { api } from "@/lib/http";
import { getImportBatch } from "@/modules/imports/queries";

export const dynamic = "force-dynamic";

export const GET = api<{ batchId: string }>(async (_req, actor, { batchId }) => {
  const batch = await getImportBatch(actor, batchId);
  if (!batch) throw notFound("lô nhập");
  return batch;
});
