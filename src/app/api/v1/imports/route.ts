import { api, pageParams } from "@/lib/http";
import { listImportBatches } from "@/modules/imports/queries";
import { previewImport } from "@/modules/imports/service";
import { readUpload } from "./upload";

export const dynamic = "force-dynamic";

/** GET /api/v1/imports?page&pageSize — các lô đã nhập của tổ chức */
export const GET = api(async (req, actor) => listImportBatches(actor, pageParams(new URL(req.url))));

/** POST multipart { file: .xlsx, sheet?: "TH" } → lưu lô xem trước. 409 file_already_applied nếu file đã áp dụng. */
export const POST = api(async (req, actor) => {
  const { file, form } = await readUpload(req);
  const sheet = form.get("sheet");
  return previewImport(actor, file, { sourceSheet: typeof sheet === "string" && sheet.trim() ? sheet.trim() : "TH" });
});
