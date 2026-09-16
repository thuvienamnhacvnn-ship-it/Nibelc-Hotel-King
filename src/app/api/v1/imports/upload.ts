import type { NextRequest } from "next/server";
import { AppError, invalid } from "@/lib/errors";
import { MAX_IMPORT_BYTES, type UploadedFile } from "@/modules/imports/service";

/** Đọc file .xlsx từ multipart/form-data (trường "file"). Chặn kích thước trước khi đọc toàn bộ nếu có Content-Length. */
export async function readUpload(req: NextRequest): Promise<{ file: UploadedFile; form: FormData }> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_IMPORT_BYTES + 64 * 1024) throw invalid(`File lớn hơn ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError("invalid_form", "Cần gửi multipart/form-data có trường file.", 400);
  }
  const entry = form.get("file");
  if (!entry || typeof entry === "string") throw invalid("Chưa chọn file.");
  const data = Buffer.from(await entry.arrayBuffer());
  return { file: { fileName: entry.name || "upload.xlsx", data }, form };
}
