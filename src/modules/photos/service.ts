import { type Queryable, pool, queryOne, withTx } from "@/lib/db";
import { AppError, conflict, forbidden, invalid, notFound } from "@/lib/errors";
import { now } from "@/lib/time";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";
import { type Actor, can } from "@/modules/auth/actor";
import { IMAGE_EXT, IMAGE_MIME, readDimensions, sniffImage } from "./image";
import { newStorageKey, readObject, removeOrphan, sha256, writeObject } from "./storage";

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
/** Cạnh ngắn dưới mức này khó nhìn rõ vết bẩn — gắn cờ, không từ chối. */
export const MIN_SHORT_EDGE = 640;
/** Đồng hồ điện thoại có thể lệch — chỉ gắn cờ khi lệch quá mức này. */
const CLOCK_SKEW_MS = 10 * 60 * 1000;

export const PHOTO_FLAG_LABELS: Record<string, string> = {
  low_resolution: `Ảnh nhỏ (cạnh ngắn < ${MIN_SHORT_EDGE}px)`,
  dimensions_unknown: "Không đọc được kích thước ảnh",
  duplicate_elsewhere: "Ảnh trùng với ảnh đã dùng cho việc/phòng khác",
  duplicate_in_task: "Ảnh trùng với ảnh khác trong cùng việc",
  captured_before_start: "Giờ chụp trên máy trước lúc bắt đầu dọn",
  capture_time_in_future: "Giờ chụp trên máy ở tương lai (đồng hồ máy sai?)",
};

export interface PhotoView {
  id: string;
  taskId: string;
  checklistItemId: string | null;
  unitId: string;
  category: string | null;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  flags: string[];
  status: "active" | "rejected" | "replaced";
  clientUploadId: string;
  clientCapturedAt: Date | null;
  receivedAt: Date;
  uploadedBy: string;
}

interface PhotoRow {
  id: string;
  task_id: string;
  checklist_item_id: string | null;
  unit_id: string;
  category: string | null;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  flags: string[];
  status: PhotoView["status"];
  client_upload_id: string;
  client_captured_at: Date | null;
  received_at: Date;
  uploaded_by: string;
  storage_key: string;
}

const PHOTO_COLS = `id, task_id, checklist_item_id, unit_id, category, mime_type, bytes, width, height, flags, status, client_upload_id, client_captured_at, received_at, uploaded_by, storage_key`;

export function toPhotoView(r: PhotoRow): PhotoView {
  return {
    id: r.id,
    taskId: r.task_id,
    checklistItemId: r.checklist_item_id,
    unitId: r.unit_id,
    category: r.category,
    mimeType: r.mime_type,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    flags: r.flags,
    status: r.status,
    clientUploadId: r.client_upload_id,
    clientCapturedAt: r.client_captured_at,
    receivedAt: r.received_at,
    uploadedBy: r.uploaded_by,
  };
}

export interface PhotoTask {
  id: string;
  unit_id: string;
  status: string;
  assigned_to: string | null;
  change_ack_required: boolean;
  started_at: Date | null;
}

/** Việc dọn trong tổ chức mà actor được xem. Việc của cleaner khác trả 404 — không lộ là việc có tồn tại. */
export async function loadVisibleTask(q: Queryable, actor: Actor, taskId: string, lock = false): Promise<PhotoTask> {
  const { rows } = await q.query<PhotoTask>(
    `SELECT id, unit_id, status, assigned_to, change_ack_required, started_at FROM cleaning_tasks WHERE id = $1 AND org_id = $2${lock ? " FOR UPDATE" : ""}`,
    [taskId, actor.orgId],
  );
  const task = rows[0];
  if (!task) throw notFound("việc dọn");
  if (!can(actor, "cleaning.view_all") && !can(actor, "cleaning.manage") && task.assigned_to !== actor.userId) throw notFound("việc dọn");
  return task;
}

/** Ai được thêm/thay ảnh: cleaner được giao khi đang dọn, hoặc điều phối (cleaning.manage) khi việc chưa đóng. */
function assertCanWritePhotos(actor: Actor, task: PhotoTask) {
  if (can(actor, "cleaning.manage")) {
    if (["passed", "cancelled"].includes(task.status)) throw conflict("task_closed", "Việc đã đóng — không thêm hay thay ảnh được nữa.");
    return;
  }
  if (!(can(actor, "cleaning.own") && task.assigned_to === actor.userId)) throw forbidden("Chỉ cleaner được giao hoặc điều phối mới gửi ảnh cho việc này.");
  if (task.status !== "in_progress") throw conflict("invalid_transition", "Chỉ gửi hoặc thay ảnh khi việc đang dọn.");
  if (task.change_ack_required) throw conflict("change_ack_required", "Việc có thay đổi chưa xác nhận. Xác nhận thay đổi trước khi gửi ảnh.");
}

export interface UploadInput {
  taskId: string;
  checklistItemId?: string | null;
  category?: string | null;
  clientUploadId: string;
  clientCapturedAt?: Date | null;
  data: Buffer;
}

const CLIENT_UPLOAD_ID = /^[A-Za-z0-9_-]{8,100}$/;

async function findByClientId(q: Queryable, actor: Actor, clientUploadId: string) {
  return queryOne<PhotoRow>(`SELECT ${PHOTO_COLS} FROM task_photos WHERE org_id = $1 AND uploaded_by = $2 AND client_upload_id = $3`, [actor.orgId, actor.userId, clientUploadId], q);
}

function sameUpload(existing: PhotoRow, input: UploadInput) {
  if (existing.task_id !== input.taskId) {
    throw conflict("client_upload_id_reused", "Mã tải lên này đã dùng cho một việc khác. Chụp lại ảnh.");
  }
  return { photo: toPhotoView(existing), alreadyStored: true };
}

/**
 * Nhận một ảnh bằng chứng. Gửi lại cùng clientUploadId (mất mạng giữa chừng) trả bản đã lưu, không lưu lần hai.
 * Cờ cảnh báo chỉ để người kiểm chú ý — không tự từ chối ảnh, không tự kết luận phòng đạt hay không.
 */
export async function uploadPhoto(actor: Actor, input: UploadInput): Promise<{ photo: PhotoView; alreadyStored: boolean }> {
  if (!actor.userId) throw forbidden("Chỉ người dùng đăng nhập mới gửi ảnh.");
  if (!CLIENT_UPLOAD_ID.test(input.clientUploadId)) throw invalid("clientUploadId không hợp lệ (8–100 ký tự chữ, số, - hoặc _).");

  const prior = await findByClientId(pool(), actor, input.clientUploadId);
  if (prior) return sameUpload(prior, input);

  // Quyền trước, định dạng sau: người không được xem việc nhận 404 dù file có hỏng.
  assertCanWritePhotos(actor, await loadVisibleTask(pool(), actor, input.taskId));

  if (input.data.length === 0) throw invalid("File ảnh rỗng.");
  if (input.data.length > MAX_PHOTO_BYTES) throw new AppError("photo_too_large", `Ảnh vượt quá ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`, 413);
  const kind = sniffImage(input.data);
  if (!kind) throw new AppError("unsupported_image", "File không phải ảnh JPEG, PNG, WebP hoặc HEIC (kiểm theo nội dung file, không theo đuôi).", 422);
  const dims = readDimensions(kind, input.data);
  const hash = sha256(input.data);

  const capturedAt = input.clientCapturedAt ?? null;
  const category = input.category?.trim() ? input.category.trim().slice(0, 80) : null;

  let writtenKey: string | null = null;
  try {
    return await withTx(async (tx) => {
      const task = await loadVisibleTask(tx, actor, input.taskId, true);
      assertCanWritePhotos(actor, task);
      // Hai lần gửi cùng lúc: lần sau chờ khoá việc rồi thấy bản lần trước.
      const again = await findByClientId(tx, actor, input.clientUploadId);
      if (again) return sameUpload(again, input);

      let itemCategory: string | null = null;
      if (input.checklistItemId) {
        const item = await tx.query<{ category: string | null }>("SELECT category FROM task_checklist_items WHERE id = $1 AND task_id = $2 AND org_id = $3", [
          input.checklistItemId,
          task.id,
          actor.orgId,
        ]);
        if (!item.rows[0]) throw notFound("mục checklist của việc này");
        itemCategory = item.rows[0].category;
      }

      const flags: string[] = [];
      if (!dims) flags.push("dimensions_unknown");
      else if (Math.min(dims.width, dims.height) < MIN_SHORT_EDGE) flags.push("low_resolution");
      const dup = await tx.query<{ elsewhere: boolean; in_task: boolean }>(
        `SELECT bool_or(task_id <> $3 OR unit_id <> $4) AS elsewhere, bool_or(task_id = $3 AND status = 'active') AS in_task
           FROM task_photos WHERE org_id = $1 AND sha256 = $2`,
        [actor.orgId, hash, task.id, task.unit_id],
      );
      if (dup.rows[0]?.elsewhere) flags.push("duplicate_elsewhere");
      if (dup.rows[0]?.in_task) flags.push("duplicate_in_task");
      // Giờ chụp do máy khách báo — chỉ là tín hiệu, không phải bằng chứng ảnh vừa chụp.
      if (capturedAt) {
        if (task.started_at && capturedAt.getTime() < new Date(task.started_at).getTime() - CLOCK_SKEW_MS) flags.push("captured_before_start");
        if (capturedAt.getTime() > now().getTime() + CLOCK_SKEW_MS) flags.push("capture_time_in_future");
      }

      const key = newStorageKey(actor.orgId, task.id, IMAGE_EXT[kind]);
      await writeObject(key, input.data);
      writtenKey = key;
      const { rows } = await tx.query<PhotoRow>(
        `INSERT INTO task_photos (org_id, task_id, checklist_item_id, unit_id, category, storage_key, mime_type, bytes, width, height, sha256, client_upload_id, client_captured_at, uploaded_by, flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${PHOTO_COLS}`,
        [
          actor.orgId,
          task.id,
          input.checklistItemId ?? null,
          task.unit_id,
          category ?? itemCategory,
          key,
          IMAGE_MIME[kind],
          input.data.length,
          dims?.width ?? null,
          dims?.height ?? null,
          hash,
          input.clientUploadId,
          capturedAt,
          actor.userId,
          flags,
        ],
      );
      await writeAudit(tx, auditActorOf(actor), "photos.uploaded", "task_photo", rows[0].id, {
        taskId: task.id,
        checklistItemId: input.checklistItemId ?? null,
        bytes: input.data.length,
        mimeType: IMAGE_MIME[kind],
        flags,
      });
      return { photo: toPhotoView(rows[0]), alreadyStored: false };
    });
  } catch (error) {
    // Bản ghi không được lưu thì file vừa ghi là mồ côi — dọn đi.
    if (writtenKey) await removeOrphan(writtenKey).catch(() => undefined);
    throw error;
  }
}

/** Đánh dấu ảnh bị thay (không xoá file — giữ dấu vết). Chỉ khi việc chưa được kiểm đạt. */
export async function replacePhoto(actor: Actor, photoId: string, reason?: string | null) {
  return withTx(async (tx) => {
    const { rows } = await tx.query<PhotoRow>(`SELECT ${PHOTO_COLS} FROM task_photos WHERE id = $1 AND org_id = $2 FOR UPDATE`, [photoId, actor.orgId]);
    const photo = rows[0];
    if (!photo) throw notFound("ảnh");
    const task = await loadVisibleTask(tx, actor, photo.task_id, true);
    if (task.status === "passed") throw conflict("task_closed", "Việc đã kiểm đạt — không thay ảnh được nữa.");
    assertCanWritePhotos(actor, task);
    if (!can(actor, "cleaning.manage") && photo.uploaded_by !== actor.userId) throw forbidden("Chỉ thay được ảnh do chính bạn gửi.");
    if (photo.status !== "active") throw conflict("photo_not_active", "Ảnh này đã bị thay hoặc loại trước đó.");
    await tx.query("UPDATE task_photos SET status = 'replaced' WHERE id = $1", [photo.id]);
    await writeAudit(tx, auditActorOf(actor), "photos.replaced", "task_photo", photo.id, { taskId: photo.task_id, reason: reason ?? null });
    return { id: photo.id, status: "replaced" as const };
  });
}

/** File ảnh để trả qua API. Cleaner chỉ đọc ảnh của việc giao cho mình; khác tổ chức ⇒ 404. */
export async function getPhotoFile(actor: Actor, photoId: string): Promise<{ data: Buffer; mimeType: string }> {
  const row = await queryOne<{ storage_key: string; mime_type: string; assigned_to: string | null }>(
    `SELECT p.storage_key, p.mime_type, t.assigned_to FROM task_photos p JOIN cleaning_tasks t ON t.id = p.task_id AND t.org_id = p.org_id
      WHERE p.id = $1 AND p.org_id = $2`,
    [photoId, actor.orgId],
  );
  if (!row) throw notFound("ảnh");
  if (!can(actor, "cleaning.view_all") && !can(actor, "cleaning.manage") && row.assigned_to !== actor.userId) throw notFound("ảnh");
  const data = await readObject(row.storage_key);
  if (!data) throw new AppError("photo_file_missing", "Bản ghi ảnh còn nhưng file không còn trên máy chủ. Báo quản trị.", 404);
  return { data, mimeType: row.mime_type };
}

export async function activePhotosForTask(q: Queryable, orgId: string, taskId: string): Promise<PhotoView[]> {
  const { rows } = await q.query<PhotoRow>(`SELECT ${PHOTO_COLS} FROM task_photos WHERE org_id = $1 AND task_id = $2 AND status = 'active' ORDER BY received_at`, [
    orgId,
    taskId,
  ]);
  return rows.map(toPhotoView);
}
