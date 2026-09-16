import { pool, query } from "@/lib/db";
import type { Actor } from "@/modules/auth/actor";
import { type RulesResult, evaluateRules } from "./qc";
import { loadVisibleTask } from "./service";

export interface EvidencePhoto {
  id: string;
  checklistItemId: string | null;
  category: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  flags: string[];
  status: "active" | "rejected" | "replaced";
  clientUploadId: string;
  clientCapturedAt: Date | null;
  receivedAt: Date;
  uploadedBy: string;
  uploadedByName: string | null;
}

export interface StoredReview {
  id: string;
  reviewerType: "ai" | "human" | "rules";
  status: "pending" | "completed" | "failed" | "not_configured";
  model: string | null;
  items: { itemKey: string; status: string; reason: string; photoIds: string[] }[];
  summary: string | null;
  error: string | null;
  createdAt: Date;
}

export interface TaskEvidence {
  photos: EvidencePhoto[];
  /** Tính lại ngay khi mở trang — không phải bản ghi cũ. */
  rules: RulesResult;
  lastRules: StoredReview | null;
  lastAi: StoredReview | null;
  replacedCount: number;
}

/** Ảnh + kết quả kiểm của một việc, cùng phạm vi quyền với trang chi tiết việc (cleaner chỉ việc của mình). */
export async function getTaskEvidence(actor: Actor, taskId: string): Promise<TaskEvidence> {
  const task = await loadVisibleTask(pool(), actor, taskId);
  const [photos, rules, reviews] = await Promise.all([
    query<{
      id: string;
      checklist_item_id: string | null;
      category: string | null;
      mime_type: string;
      width: number | null;
      height: number | null;
      bytes: number;
      flags: string[];
      status: EvidencePhoto["status"];
      client_upload_id: string;
      client_captured_at: Date | null;
      received_at: Date;
      uploaded_by: string;
      uploaded_by_name: string | null;
    }>(
      `SELECT p.id, p.checklist_item_id, p.category, p.mime_type, p.width, p.height, p.bytes, p.flags, p.status, p.client_upload_id,
              p.client_captured_at, p.received_at, p.uploaded_by, u.full_name AS uploaded_by_name
         FROM task_photos p LEFT JOIN users u ON u.id = p.uploaded_by AND u.org_id = p.org_id
        WHERE p.task_id = $1 AND p.org_id = $2 ORDER BY p.received_at`,
      [task.id, actor.orgId],
    ),
    evaluateRules(pool(), actor.orgId, task.id),
    query<{ id: string; reviewer_type: StoredReview["reviewerType"]; status: StoredReview["status"]; model: string | null; items: StoredReview["items"]; summary: string | null; error: string | null; created_at: Date }>(
      `SELECT DISTINCT ON (reviewer_type) id, reviewer_type, status, model, items, summary, error, created_at
         FROM qc_reviews WHERE task_id = $1 AND org_id = $2 AND reviewer_type IN ('rules','ai') ORDER BY reviewer_type, created_at DESC, id`,
      [task.id, actor.orgId],
    ),
  ]);
  const toReview = (r: (typeof reviews)[number] | undefined): StoredReview | null =>
    r ? { id: r.id, reviewerType: r.reviewer_type, status: r.status, model: r.model, items: r.items ?? [], summary: r.summary, error: r.error, createdAt: r.created_at } : null;
  const active = photos.filter((p) => p.status === "active");
  return {
    photos: active.map((p) => ({
      id: p.id,
      checklistItemId: p.checklist_item_id,
      category: p.category,
      mimeType: p.mime_type,
      width: p.width,
      height: p.height,
      bytes: p.bytes,
      flags: p.flags,
      status: p.status,
      clientUploadId: p.client_upload_id,
      clientCapturedAt: p.client_captured_at,
      receivedAt: p.received_at,
      uploadedBy: p.uploaded_by,
      uploadedByName: p.uploaded_by_name,
    })),
    rules,
    lastRules: toReview(reviews.find((r) => r.reviewer_type === "rules")),
    lastAi: toReview(reviews.find((r) => r.reviewer_type === "ai")),
    replacedCount: photos.length - active.length,
  };
}
