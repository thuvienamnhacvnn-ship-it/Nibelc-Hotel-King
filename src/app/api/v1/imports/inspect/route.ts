import { api } from "@/lib/http";
import { inspectImportFile } from "@/modules/imports/service";
import { readUpload } from "../upload";

export const dynamic = "force-dynamic";

/** POST multipart { file } → danh sách sheet (có bảng booking hay không). Không lưu gì. */
export const POST = api(async (req, actor) => {
  const { file } = await readUpload(req);
  return inspectImportFile(actor, file);
});
