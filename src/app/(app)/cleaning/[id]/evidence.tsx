import { Badge, EmptyState, Notice } from "@/components/ui";
import { formatInstant } from "@/lib/time";
import type { ChecklistItemRow } from "@/modules/cleaning/queries";
import type { RuleItem } from "@/modules/photos/qc";
import type { EvidencePhoto, StoredReview, TaskEvidence } from "@/modules/photos/queries";
import { PHOTO_FLAG_LABELS } from "@/modules/photos/service";
import { VISION_NOT_CONFIGURED } from "@/modules/photos/vision";
import styles from "./evidence.module.css";
import { RerunReviewButton } from "./evidence-actions";

const RULE_BADGE: Record<RuleItem["status"], { tone: "ok" | "warn" | "danger"; label: string }> = {
  has_evidence: { tone: "ok", label: "Có ảnh" },
  flagged: { tone: "warn", label: "Có ảnh — cần xem kỹ" },
  insufficient: { tone: "danger", label: "Không đủ bằng chứng" },
};

const AI_ITEM_LABEL: Record<string, { tone: "ok" | "danger" | "warn"; label: string }> = {
  pass: { tone: "ok", label: "AI: thấy đạt" },
  fail: { tone: "danger", label: "AI: thấy lỗi" },
  insufficient: { tone: "warn", label: "AI: không đủ bằng chứng" },
};

function AiStatus({ review }: { review: StoredReview | null }) {
  if (!review) return <Badge tone="warn">Chưa chạy AI — kiểm tay</Badge>;
  if (review.status === "not_configured") return <Badge tone="warn">{VISION_NOT_CONFIGURED}</Badge>;
  if (review.status === "failed") return <Badge tone="danger" title={review.error ?? undefined}>{review.summary ?? "AI lỗi — kiểm tay"}</Badge>;
  if (review.status === "completed") return <Badge tone="info">{review.summary ?? "AI đã gợi ý — người kiểm quyết định"}</Badge>;
  return <Badge tone="neutral">AI đang chạy</Badge>;
}

/** Ảnh bằng chứng theo hạng mục + kết quả kiểm theo luật + trạng thái AI. Không có gì ở đây tự duyệt phòng. */
export function EvidenceSection({
  evidence,
  checklist,
  tz,
  canReview,
  taskId,
}: {
  evidence: TaskEvidence;
  checklist: ChecklistItemRow[];
  tz: string;
  canReview: boolean;
  taskId: string;
}) {
  const { rules, photos, lastAi, lastRules } = evidence;
  const ruleByItem = new Map(rules.items.map((r) => [r.itemId, r]));
  const aiByKey = new Map((lastAi?.status === "completed" ? lastAi.items : []).map((i) => [i.itemKey, i]));
  const rows = checklist.filter((c) => c.requires_photo || photos.some((p) => p.checklistItemId === c.id));
  const loose = photos.filter((p) => !p.checklistItemId || !checklist.some((c) => c.id === p.checklistItemId));

  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Badge tone={!rules.complete ? "danger" : rules.flaggedCount ? "warn" : "ok"}>Kiểm theo luật: {rules.summary}</Badge>
        <AiStatus review={lastAi} />
        <span className="spacer" />
        {canReview ? <RerunReviewButton taskId={taskId} /> : null}
      </div>
      <div className="small muted">
        Luật chỉ kiểm có ảnh hay không và cờ cảnh báo; AI chỉ gợi ý. Mùi, vi sinh, độ khô, thiết bị hoạt động không kết luận được từ ảnh. Budapest Team quyết định
        đạt / cần dọn lại.
        {lastRules ? ` Lần ghi kết quả luật gần nhất: ${formatInstant(lastRules.createdAt, tz)}.` : ""}
        {lastAi ? ` Lượt AI gần nhất: ${formatInstant(lastAi.createdAt, tz)}.` : ""}
      </div>

      {rows.length === 0 && loose.length === 0 ? <EmptyState title="Việc này chưa có ảnh và không có mục bắt buộc chụp ảnh" /> : null}

      {rows.map((c) => {
        const rule = ruleByItem.get(c.id);
        const ai = aiByKey.get(c.item_key);
        const own = photos.filter((p) => p.checklistItemId === c.id);
        return (
          <div key={c.id} className={styles.item}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="strong">{c.label}</span>
              {c.category ? <span className="small faint">{c.category}</span> : null}
              {c.requires_photo ? null : <span className="small faint">(không bắt buộc ảnh)</span>}
              <span className="spacer" />
              {rule ? <Badge tone={RULE_BADGE[rule.status].tone}>{RULE_BADGE[rule.status].label}</Badge> : null}
              {ai ? (
                <Badge tone={AI_ITEM_LABEL[ai.status]?.tone ?? "neutral"} title={ai.reason}>
                  {AI_ITEM_LABEL[ai.status]?.label ?? ai.status}
                </Badge>
              ) : null}
            </div>
            {rule?.needsPhysicalCheck ? <div className="small strong">Ảnh không chứng minh được mục này — cần cleaner xác nhận hoặc kiểm tại chỗ.</div> : null}
            {ai?.reason ? <div className="small muted">AI: {ai.reason}</div> : null}
            {own.length ? (
              <PhotoGrid photos={own} tz={tz} />
            ) : (
              <div className="small" style={{ color: "var(--danger)", fontWeight: 700 }}>
                Chưa có ảnh.
              </div>
            )}
          </div>
        );
      })}

      {loose.length ? (
        <div className={styles.item}>
          <span className="strong">Ảnh khác (không gắn mục checklist)</span>
          <PhotoGrid photos={loose} tz={tz} />
        </div>
      ) : null}

      {evidence.replacedCount ? <div className="small faint">{evidence.replacedCount} ảnh đã bị thay (file vẫn giữ trên máy chủ, không hiển thị ở đây).</div> : null}
    </div>
  );
}

function PhotoGrid({ photos, tz }: { photos: EvidencePhoto[]; tz: string }) {
  return (
    <div className={styles.grid}>
      {photos.map((p) => (
        <figure key={p.id} className={styles.photo}>
          <a href={`/api/v1/photos/${p.id}`} target="_blank" rel="noopener noreferrer" title="Mở ảnh gốc">
            {p.mimeType === "image/heic" ? (
              <span className={styles.heic}>HEIC — bấm để tải xem</span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/v1/photos/${p.id}`} alt={`Ảnh bằng chứng ${p.category ?? ""}`} loading="lazy" />
            )}
          </a>
          <figcaption>
            <div className="small strong">{p.uploadedByName ?? "—"}</div>
            <div className="small muted">Máy chủ nhận {formatInstant(p.receivedAt, tz)}</div>
            {p.clientCapturedAt ? <div className="small faint">Giờ chụp theo máy: {formatInstant(p.clientCapturedAt, tz)}</div> : null}
            {p.width && p.height ? (
              <div className="small faint">
                {p.width}×{p.height}px
              </div>
            ) : null}
            {p.flags.map((f) => (
              <div key={f}>
                <Badge tone="warn">{PHOTO_FLAG_LABELS[f] ?? f}</Badge>
              </div>
            ))}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** Ở bước kiểm phòng: nói rõ mục thiếu bằng chứng trước khi người kiểm bấm. */
export function InspectionEvidenceNotice({ evidence }: { evidence: TaskEvidence }) {
  const { rules } = evidence;
  if (!rules.complete) {
    return (
      <Notice tone="danger" title="Kiểm phòng: thiếu bằng chứng ảnh">
        Chưa có ảnh cho: {rules.missing.join(", ")}. Kiểm tại chỗ hoặc yêu cầu dọn lại — không duyệt chỉ dựa vào checklist đã tích.
      </Notice>
    );
  }
  const flagged = rules.items.filter((i) => i.status === "flagged");
  const physical = rules.items.filter((i) => i.needsPhysicalCheck);
  if (!flagged.length && !physical.length) return null;
  return (
    <Notice tone="warn" title="Kiểm phòng: cần xem kỹ">
      {flagged.length ? `Ảnh có cờ cảnh báo ở: ${flagged.map((i) => i.label).join(", ")}. ` : ""}
      {physical.length ? `Không kết luận được từ ảnh: ${physical.map((i) => i.label).join(", ")}.` : ""}
    </Notice>
  );
}
