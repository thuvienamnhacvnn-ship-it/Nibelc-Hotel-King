import { notFound } from "@/lib/errors";
import { api, pageParams } from "@/lib/http";
import { getImportBatch, listImportRows } from "@/modules/imports/queries";

export const dynamic = "force-dynamic";

/** GET ?disposition&issue&sheet&page&pageSize — tên/SĐT khách bị ẩn nếu thiếu booking.view_guest_contact */
export const GET = api<{ batchId: string }>(async (req, actor, { batchId }) => {
  if (!(await getImportBatch(actor, batchId))) throw notFound("lô nhập");
  const url = new URL(req.url);
  const sp = url.searchParams;
  return listImportRows(actor, batchId, { disposition: sp.get("disposition"), issue: sp.get("issue"), sheet: sp.get("sheet") }, pageParams(url));
});
