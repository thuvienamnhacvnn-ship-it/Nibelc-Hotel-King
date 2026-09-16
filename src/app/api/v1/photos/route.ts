import { api } from "@/lib/http";
import { AppError, invalid } from "@/lib/errors";
import { MAX_PHOTO_BYTES, uploadPhoto } from "@/modules/photos/service";

/** Multipart: file, taskId, checklistItemId?, category?, clientUploadId (bắt buộc), clientCapturedAt? (ISO). */
export const POST = api(async (req, actor) => {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    throw new AppError("unsupported_media_type", "Gửi ảnh bằng multipart/form-data.", 415);
  }
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_PHOTO_BYTES + 1024 * 1024) throw new AppError("photo_too_large", `Ảnh vượt quá ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`, 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError("invalid_multipart", "Không đọc được dữ liệu multipart.", 400);
  }
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const file = form.get("file");
  if (!file || typeof file === "string") throw invalid("Thiếu file ảnh (trường 'file').");
  const taskId = text("taskId");
  const checklistItemId = text("checklistItemId");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!taskId || !uuid.test(taskId)) throw invalid("taskId không hợp lệ.");
  if (checklistItemId && !uuid.test(checklistItemId)) throw invalid("checklistItemId không hợp lệ.");
  const clientUploadId = text("clientUploadId");
  if (!clientUploadId) throw invalid("Thiếu clientUploadId (mã do máy sinh khi chụp).");
  const capturedRaw = text("clientCapturedAt");
  const clientCapturedAt = capturedRaw ? new Date(capturedRaw) : null;
  if (clientCapturedAt && Number.isNaN(clientCapturedAt.getTime())) throw invalid("clientCapturedAt không phải thời điểm hợp lệ.");
  if (file.size > MAX_PHOTO_BYTES) throw new AppError("photo_too_large", `Ảnh vượt quá ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`, 413);

  return uploadPhoto(actor, {
    taskId,
    checklistItemId,
    category: text("category"),
    clientUploadId,
    clientCapturedAt,
    data: Buffer.from(await file.arrayBuffer()),
  });
});
