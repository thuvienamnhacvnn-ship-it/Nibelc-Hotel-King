import { api, pageParams } from "@/lib/http";
import { listImportBatches } from "@/modules/imports/queries";
import { previewImport } from "@/modules/imports/service";
import { readUpload } from "./upload";

export const dynamic = "force-dynamic";

/** GET /api/v1/imports?page&pageSize — các lô đã nhập của tổ chức */
export const GET = api(async (req, actor) => listImportBatches(actor, pageParams(new URL(req.url))));

/**
 * POST multipart { file: .xlsx, sheet?: "TH", connectorId?: uuid, sourceAccount?: nhãn } → lưu lô xem trước.
 * 409 file_already_applied nếu file đã áp dụng; 422 source_account_required khi tổ chức có nhiều tài khoản cùng kênh.
 */
export const POST = api(async (req, actor) => {
  const { file, form } = await readUpload(req);
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return previewImport(actor, file, {
    sourceSheet: text("sheet") ?? "TH",
    connectorId: text("connectorId"),
    sourceAccount: text("sourceAccount"),
  });
});
