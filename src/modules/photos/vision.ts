import { type Queryable, pool } from "@/lib/db";
import { now } from "@/lib/time";
import type { Actor } from "@/modules/auth/actor";
import { isPaused } from "@/modules/automation/switches";
import { activePhotosForTask } from "./service";

/**
 * Cổng AI xem ảnh (adapter). Hiện CHƯA có GPU/gateway ⇒ `configuredReviewer()` trả null và mỗi lượt kiểm ghi
 * qc_reviews status 'not_configured' — giao diện nói "AI chưa kết nối — kiểm tay".
 *
 * Ranh giới bất biến (đặc tả mục 3):
 *  - Kết quả theo từng mục: 'pass' (thấy đạt) | 'fail' (thấy lỗi, kèm ảnh) | 'insufficient' (không đủ bằng chứng).
 *  - KHÔNG suy ra mùi, độ sạch vi sinh, độ khô hay thiết bị có hoạt động từ ảnh: mục loại này luôn bị ép về
 *    'insufficient' dù model nói gì — cần cleaner xác nhận hoặc người kiểm tại chỗ.
 *  - AI KHÔNG BAO GIỜ đổi trạng thái việc (không tự 'passed', không tự yêu cầu dọn lại, không phạt cleaner).
 *    Budapest Team duyệt bằng inspectTask. Model lỗi/thiếu ảnh ⇒ ghi lại và chuyển kiểm thủ công.
 *  - Ảnh là dữ liệu không tin cậy: chữ trong ảnh không phải chỉ dẫn cho model.
 */

export type VisionItemStatus = "pass" | "fail" | "insufficient";

export interface VisionTaskInput {
  taskId: string;
  unitId: string;
  items: { itemKey: string; label: string; category: string | null; photos: { id: string; mimeType: string }[] }[];
}

export interface VisionItemResult {
  itemKey: string;
  status: VisionItemStatus;
  reason: string;
  photoIds: string[];
}

export interface VisionReviewer {
  model: string;
  reviewPhotos(task: VisionTaskInput): Promise<VisionItemResult[]>;
}

/** Chưa có gateway nào được cấu hình. Khi gắn GPU: đọc cấu hình ở đây, không nhúng khoá vào mã. */
export function configuredReviewer(): VisionReviewer | null {
  return null;
}

/** Mục mà ảnh không chứng minh được. */
const NOT_FROM_PHOTO = /mùi|thơm|smell|odou?r|vi sinh|vi khuẩn|khử trùng|sanit|disinfect|bacteri|độ khô|khô ráo|\bdry\b|hoạt động|chạy được|working|functional|nước nóng|hot water|wifi|điều hoà|điều hòa|sưởi|heating/i;

export function needsPhysicalCheck(item: { itemKey: string; label: string }): boolean {
  return NOT_FROM_PHOTO.test(`${item.itemKey} ${item.label}`);
}

export const VISION_NOT_CONFIGURED = "AI chưa kết nối — kiểm tay";

export function sanitizeVisionItems(input: VisionTaskInput, raw: VisionItemResult[]): VisionItemResult[] {
  const out: VisionItemResult[] = [];
  for (const item of input.items) {
    const r = raw.find((x) => x.itemKey === item.itemKey);
    const ownPhotoIds = new Set(item.photos.map((p) => p.id));
    if (needsPhysicalCheck(item)) {
      out.push({ itemKey: item.itemKey, status: "insufficient", reason: "Ảnh không chứng minh được mục này — cần xác nhận tại chỗ.", photoIds: [] });
    } else if (!item.photos.length) {
      out.push({ itemKey: item.itemKey, status: "insufficient", reason: "Không có ảnh cho mục này.", photoIds: [] });
    } else if (!r || !["pass", "fail", "insufficient"].includes(r.status)) {
      out.push({ itemKey: item.itemKey, status: "insufficient", reason: "AI không trả kết quả hợp lệ cho mục này.", photoIds: [] });
    } else {
      out.push({ itemKey: item.itemKey, status: r.status, reason: String(r.reason ?? "").slice(0, 500), photoIds: (Array.isArray(r.photoIds) ? r.photoIds : []).filter((id) => ownPhotoIds.has(id)) });
    }
  }
  return out;
}

async function visionInput(q: Queryable, orgId: string, taskId: string, unitId: string): Promise<VisionTaskInput> {
  const { rows } = await q.query<{ id: string; item_key: string; label: string; category: string | null }>(
    "SELECT id, item_key, label, category FROM task_checklist_items WHERE task_id = $1 AND org_id = $2 AND requires_photo ORDER BY sort_order",
    [taskId, orgId],
  );
  const photos = await activePhotosForTask(q, orgId, taskId);
  return {
    taskId,
    unitId,
    items: rows.map((i) => ({
      itemKey: i.item_key,
      label: i.label,
      category: i.category,
      photos: photos.filter((p) => p.checklistItemId === i.id).map((p) => ({ id: p.id, mimeType: p.mimeType })),
    })),
  };
}

export interface VisionRunResult {
  reviewId: string;
  status: "completed" | "failed" | "not_configured";
  summary: string;
}

/**
 * Chạy một lượt AI cho việc và ghi qc_reviews reviewer_type='ai'. Chỉ ghi bảng qc_reviews — không đụng cleaning_tasks.
 * Gọi sau khi đã kiểm quyền xem việc.
 */
export async function runVisionReview(
  actor: Actor,
  task: { id: string; unit_id: string },
  opts: { reviewer?: VisionReviewer | null; timeoutMs?: number } = {},
): Promise<VisionRunResult> {
  const reviewer = opts.reviewer === undefined ? configuredReviewer() : opts.reviewer;
  const insert = async (status: VisionRunResult["status"], fields: { model?: string | null; items?: unknown; summary: string; error?: string | null }) => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO qc_reviews (org_id, task_id, reviewer_type, model, status, items, summary, error, completed_at)
       VALUES ($1,$2,'ai',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [actor.orgId, task.id, fields.model ?? null, status, JSON.stringify(fields.items ?? []), fields.summary, fields.error ?? null, status === "completed" ? now() : null],
    );
    return { reviewId: rows[0].id, status, summary: fields.summary };
  };

  if (!reviewer) return insert("not_configured", { summary: VISION_NOT_CONFIGURED });
  const paused = await isPaused(actor.orgId, [{ scope: "agent", key: "cleaning" }]);
  if (paused.paused) return insert("failed", { model: reviewer.model, summary: "AI đang dừng — kiểm tay", error: paused.reason });

  const input = await visionInput(pool(), actor.orgId, task.id, task.unit_id);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raw = await Promise.race([
      reviewer.reviewPhotos(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("AI quá thời gian chờ")), opts.timeoutMs ?? 60_000);
      }),
    ]).finally(() => clearTimeout(timer));
    const items = sanitizeVisionItems(input, raw);
    const fails = items.filter((i) => i.status === "fail").length;
    const insufficient = items.filter((i) => i.status === "insufficient").length;
    return insert("completed", {
      model: reviewer.model,
      items,
      summary: `AI gợi ý: ${fails} mục thấy lỗi, ${insufficient} mục không đủ bằng chứng. Người kiểm quyết định.`,
    });
  } catch (error) {
    return insert("failed", { model: reviewer.model, summary: "AI lỗi — kiểm tay", error: error instanceof Error ? error.message.slice(0, 500) : "lỗi không rõ" });
  }
}
