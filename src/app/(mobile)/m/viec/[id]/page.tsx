import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, DemoBadge } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant, now } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { INCIDENT_KIND_LABELS, INCIDENT_SEVERITY_LABELS, getTaskDetail } from "@/modules/cleaning/queries";
import { TASK_KIND_LABELS, TASK_STATUS_LABELS } from "@/modules/cleaning/service";
import { getTaskEvidence } from "@/modules/photos/queries";
import { PHOTO_FLAG_LABELS } from "@/modules/photos/service";
import { type ChangeValues, changeRows, statusTone } from "../../../../(app)/cleaning/_components/format";
import styles from "../../../mobile.module.css";
import { MobileTaskFlow } from "../../../mobile-client";
import { EvidenceChecklist } from "./photo-flow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Việc dọn" };

/** Chi tiết việc cho cleaner. KHÔNG hiện tên, số điện thoại khách hay giá — chỉ thông tin cần để làm việc. */
export default async function MobileTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor(["cleaning.own", "cleaning.view_all"]);
  const { id } = await params;
  let detail;
  try {
    detail = await getTaskDetail(actor, id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const { task: t, checklist, incidents } = detail;
  const tz = actor.timezone;
  const pending = t.pending_change as (ChangeValues & { reason?: string }) | null;
  const rows = pending
    ? changeRows(pending, { kind: t.kind, service_date: t.service_date, due_at: t.due_at, earliest_start_at: t.earliest_start_at ?? undefined, arriving_booking_id: t.arriving_booking_id }, tz)
    : [];
  const groups = new Map<string, { id: string; label: string; checked: boolean }[]>();
  for (const i of checklist) {
    const key = i.category ?? "Checklist";
    groups.set(key, [...(groups.get(key) ?? []), { id: i.id, label: i.label, checked: i.checked }]);
  }
  const mapsUrl = t.property_address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.property_address)}` : null;
  const openIncidents = incidents.filter((i) => i.status !== "resolved");
  const evidence = t.status === "in_progress" ? await getTaskEvidence(actor, t.id) : null;
  const evidenceGroups = new Map<string, { id: string; label: string; checked: boolean; requiresPhoto: boolean }[]>();
  for (const i of checklist) {
    const key = i.category ?? "Checklist";
    evidenceGroups.set(key, [...(evidenceGroups.get(key) ?? []), { id: i.id, label: i.label, checked: i.checked, requiresPhoto: i.requires_photo }]);
  }

  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <Link href="/m" className={`btn ${styles.logout}`}>
          ← Danh sách
        </Link>
        <span className="spacer" />
        <span className="small strong muted">Cập nhật {formatInstant(now(), tz)}</span>
      </div>

      {t.change_ack_required && pending ? (
        <div className={`${styles.card} ${styles.cardUrgent}`} role="alert">
          <div className={styles.due} style={{ color: "var(--danger)" }}>
            Việc này đã thay đổi
          </div>
          {pending.reason ? <div className={styles.line}>{pending.reason}</div> : null}
          <dl className={styles.facts} style={{ marginTop: 8 }}>
            {rows.map((r) => (
              <div key={r.label} style={{ display: "contents" }}>
                <dt>{r.label}</dt>
                <dd>
                  {r.before ? <span style={{ textDecoration: "line-through", fontWeight: 500 }}>{r.before}</span> : null}
                  {r.before ? " → " : ""}
                  {r.after}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <div className={styles.card}>
        <div className="row" style={{ gap: 8 }}>
          <span className={styles.unit}>{t.unit_code}</span>
          <span className="spacer" />
          <DemoBadge show={t.is_demo} />
        </div>
        <div className={styles.line}>
          {t.unit_name} · {t.property_name}
        </div>
        <div className={styles.badges}>
          <Badge tone={statusTone(t.status)}>{TASK_STATUS_LABELS[t.status]}</Badge>
          <Badge tone={t.kind === "turnover" ? "danger" : "neutral"}>{TASK_KIND_LABELS[t.kind]}</Badge>
          {t.overdue ? <Badge tone="danger">Quá hạn</Badge> : null}
        </div>
        <dl className={styles.facts} style={{ marginTop: 12 }}>
          <dt>Địa chỉ</dt>
          <dd>
            {t.property_address ?? "Chưa có — hỏi điều phối"}
            {mapsUrl ? (
              <div>
                <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={`btn ${styles.logout}`} style={{ marginTop: 6 }}>
                  Mở Google Maps
                </a>
              </div>
            ) : null}
          </dd>
          <dt>Ngày</dt>
          <dd>{formatDateVi(t.service_date)}</dd>
          <dt>Sớm nhất</dt>
          <dd>{t.earliest_start_at ? formatInstant(t.earliest_start_at, tz) : "—"}</dd>
          <dt>HẠN XONG</dt>
          <dd style={{ fontSize: 19 }}>{formatInstant(t.due_at, tz)}</dd>
          <dt>Khách đến</dt>
          <dd>{t.next_arrival_at ? formatInstant(t.next_arrival_at, tz) : "Chưa có khách đến tiếp"}</dd>
          {t.next_arrival_at ? (
            <>
              <dt>Số khách</dt>
              <dd>{t.arriving_guests ?? "Chưa rõ"}</dd>
            </>
          ) : null}
          <dt>Khách cũ</dt>
          <dd>{t.vacancy.ok ? "Đã rời phòng" : "CHƯA xác nhận đã rời — không vào phòng"}</dd>
        </dl>
        {t.note ? <div className={styles.line}>Ghi chú: {t.note}</div> : null}
      </div>

      {t.status === "awaiting_inspection" ? (
        <div className="notice notice-info strong">Máy chủ đã nhận báo hoàn thành. Đang chờ Budapest Team kiểm phòng.</div>
      ) : null}
      {t.status === "passed" ? <div className="notice notice-info strong">Phòng đã được kiểm đạt.</div> : null}
      {t.status === "cancelled" ? <div className="notice notice-warn strong">Việc này đã bị hủy.</div> : null}
      {t.status === "needs_reclean" ? <div className="notice notice-danger strong">Kiểm phòng chưa đạt — cần dọn lại. Nhận việc để làm tiếp.</div> : null}

      {openIncidents.length ? (
        <section className={styles.group}>
          <h2 className={styles.sectionTitle}>Sự cố đang mở ({openIncidents.length})</h2>
          {openIncidents.map((i) => (
            <div key={i.id} className={styles.card}>
              <div className={styles.badges} style={{ marginTop: 0 }}>
                <Badge tone={i.severity === "blocking" ? "danger" : "warn"}>{INCIDENT_SEVERITY_LABELS[i.severity]}</Badge>
                <Badge tone="neutral">{INCIDENT_KIND_LABELS[i.kind]}</Badge>
              </div>
              <div className={styles.line}>{i.description}</div>
            </div>
          ))}
        </section>
      ) : null}

      <MobileTaskFlow
        taskId={t.id}
        version={t.version}
        status={t.status}
        isAssignee={t.assigned_to === actor.userId}
        canManage={can(actor, "cleaning.manage")}
        changeAckRequired={t.change_ack_required}
        changeRows={rows}
        changeReason={pending?.reason ?? null}
        vacancyOk={t.vacancy.ok}
        vacancyMessage={t.vacancy.message}
        checklist={[...groups.entries()].map(([group, items]) => ({ group, items }))}
        inProgressSlot={
          evidence ? (
            <EvidenceChecklist
              taskId={t.id}
              version={t.version}
              canAct={t.assigned_to === actor.userId || can(actor, "cleaning.manage")}
              canManage={can(actor, "cleaning.manage")}
              checklist={[...evidenceGroups.entries()].map(([group, items]) => ({ group, items }))}
              serverPhotos={evidence.photos.map((ph) => ({
                id: ph.id,
                checklistItemId: ph.checklistItemId,
                clientUploadId: ph.clientUploadId,
                flags: ph.flags,
                receivedAtLabel: `Máy chủ nhận ${formatInstant(ph.receivedAt, tz)}`,
                mine: ph.uploadedBy === actor.userId,
              }))}
              flagLabels={PHOTO_FLAG_LABELS}
            />
          ) : undefined
        }
      />
    </>
  );
}
