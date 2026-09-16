import { type Queryable, pool } from "@/lib/db";
import { AppError, forbidden } from "@/lib/errors";
import { now } from "@/lib/time";
import { type Actor, can } from "@/modules/auth/actor";
import { finishTask } from "@/modules/cleaning/service";
import { PHOTO_FLAG_LABELS, activePhotosForTask, loadVisibleTask } from "./service";
import { runVisionReview, needsPhysicalCheck } from "./vision";

/**
 * Kiểm theo luật (không AI): mục checklist cần ảnh có ảnh active chưa, ảnh có cờ cảnh báo không.
 * Luật chỉ xác nhận CÓ bằng chứng — không bao giờ kết luận phòng sạch/đạt. Người kiểm (Budapest Team) quyết định.
 */

export type RuleStatus = "has_evidence" | "flagged" | "insufficient";

export interface RuleItem {
  itemId: string;
  itemKey: string;
  label: string;
  category: string | null;
  status: RuleStatus;
  reason: string;
  photoIds: string[];
  flags: string[];
  /** Ảnh không chứng minh được (mùi, vi sinh, thiết bị hoạt động…) — cần xác nhận tại chỗ. */
  needsPhysicalCheck: boolean;
}

export interface RulesResult {
  complete: boolean;
  missing: string[];
  flaggedCount: number;
  items: RuleItem[];
  summary: string;
}

export async function evaluateRules(q: Queryable, orgId: string, taskId: string): Promise<RulesResult> {
  const { rows } = await q.query<{ id: string; item_key: string; label: string; category: string | null }>(
    "SELECT id, item_key, label, category FROM task_checklist_items WHERE task_id = $1 AND org_id = $2 AND requires_photo ORDER BY sort_order, label",
    [taskId, orgId],
  );
  const photos = await activePhotosForTask(q, orgId, taskId);
  const items: RuleItem[] = rows.map((i) => {
    const own = photos.filter((p) => p.checklistItemId === i.id);
    const flags = [...new Set(own.flatMap((p) => p.flags))];
    const base = { itemId: i.id, itemKey: i.item_key, label: i.label, category: i.category, photoIds: own.map((p) => p.id), flags, needsPhysicalCheck: needsPhysicalCheck({ itemKey: i.item_key, label: i.label }) };
    if (!own.length) return { ...base, status: "insufficient" as const, reason: "Không đủ bằng chứng: chưa có ảnh." };
    if (flags.length) return { ...base, status: "flagged" as const, reason: `Có ảnh nhưng cần xem kỹ: ${flags.map((f) => PHOTO_FLAG_LABELS[f] ?? f).join("; ")}.` };
    return { ...base, status: "has_evidence" as const, reason: `Có ${own.length} ảnh.` };
  });
  const missing = items.filter((i) => i.status === "insufficient").map((i) => i.label);
  const flaggedCount = items.filter((i) => i.status === "flagged").length;
  const summary = missing.length
    ? `Không đủ bằng chứng: thiếu ảnh ${missing.length} mục.`
    : flaggedCount
      ? `Đủ ảnh bắt buộc; ${flaggedCount} mục có ảnh cần xem kỹ.`
      : items.length
        ? "Đủ ảnh bắt buộc, không có cờ cảnh báo."
        : "Việc này không có mục bắt buộc chụp ảnh.";
  return { complete: missing.length === 0, missing, flaggedCount, items, summary };
}

export async function recordRulesReview(actor: Actor, taskId: string, result: RulesResult): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO qc_reviews (org_id, task_id, reviewer_type, status, items, summary, completed_at) VALUES ($1,$2,'rules','completed',$3,$4,$5) RETURNING id`,
    [actor.orgId, taskId, JSON.stringify(result.items), result.summary, now()],
  );
  return rows[0].id;
}

/** Chạy lại kiểm luật + AI cho một việc (nút "Kiểm lại" của điều phối/kiểm phòng). Không đổi trạng thái việc. */
export async function reviewTask(actor: Actor, taskId: string) {
  if (!can(actor, "cleaning.manage") && !can(actor, "readiness.approve")) throw forbidden("Chỉ điều phối hoặc người kiểm phòng chạy kiểm lại.");
  const task = await loadVisibleTask(pool(), actor, taskId);
  const rules = await evaluateRules(pool(), actor.orgId, task.id);
  const rulesReviewId = await recordRulesReview(actor, task.id, rules);
  const ai = await runVisionReview(actor, task);
  return { rules: { reviewId: rulesReviewId, ...rules }, ai };
}

/**
 * Báo hoàn thành có kiểm ảnh: thiếu ảnh bắt buộc ⇒ 422 photo_evidence_missing (máy chủ quyết định, không tin nút bị khoá ở máy).
 * Đủ ảnh thì gọi finishTask của module cleaning, rồi ghi kết quả luật và lượt AI (AI lỗi không làm hỏng việc hoàn thành).
 */
export async function finishWithEvidence(actor: Actor, taskId: string, input: { expectedVersion?: number; note?: string | null } = {}) {
  const task = await loadVisibleTask(pool(), actor, taskId);
  // Việc không ở trạng thái đang dọn: để finishTask báo đúng lỗi trạng thái/quyền.
  if (task.status !== "in_progress") return finishTask(actor, taskId, input);
  const rules = await evaluateRules(pool(), actor.orgId, task.id);
  if (!rules.complete) {
    await recordRulesReview(actor, task.id, rules);
    throw new AppError("photo_evidence_missing", `Còn ${rules.missing.length} mục chưa có ảnh bằng chứng.`, 422, { missing: rules.missing });
  }
  const result = await finishTask(actor, taskId, input);
  await recordRulesReview(actor, task.id, rules);
  let ai: { status: string; summary: string } | null = null;
  try {
    ai = await runVisionReview(actor, task);
  } catch (error) {
    console.error("[photos] không ghi được lượt AI sau khi hoàn thành:", error instanceof Error ? error.message : error);
  }
  return { ...result, qc: { rules: rules.summary, ai: ai?.summary ?? null } };
}
