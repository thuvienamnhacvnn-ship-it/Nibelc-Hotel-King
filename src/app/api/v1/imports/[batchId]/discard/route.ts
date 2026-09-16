import { api } from "@/lib/http";
import { discardImport } from "@/modules/imports/service";

export const dynamic = "force-dynamic";

/** POST → huỷ lô chưa áp dụng (giữ dòng để truy vết). */
export const POST = api<{ batchId: string }>(async (_req, actor, { batchId }) => discardImport(actor, batchId));
