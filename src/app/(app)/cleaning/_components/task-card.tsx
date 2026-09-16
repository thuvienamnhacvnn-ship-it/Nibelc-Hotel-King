import Link from "next/link";
import { Badge, DemoBadge } from "@/components/ui";
import { formatDateVi, formatInstant } from "@/lib/time";
import type { TaskView } from "@/modules/cleaning/queries";
import { TASK_KIND_LABELS, TASK_STATUS_LABELS } from "@/modules/cleaning/service";
import styles from "../cleaning.module.css";
import { type ChangeValues, changeRows, statusTone } from "./format";
import { type ActionPerms, type ActionTask, TaskActions } from "./task-actions";

export function toActionTask(t: TaskView, tz: string): ActionTask {
  const pending = t.pending_change as (ChangeValues & { reason?: string }) | null;
  return {
    id: t.id,
    status: t.status,
    version: t.version,
    unitCode: t.unit_code,
    assigneeName: t.assignee_name,
    changeAckRequired: t.change_ack_required,
    vacancyOk: t.vacancy.ok,
    kind: t.kind,
    changeRows: pending ? changeRows(pending, { kind: t.kind, service_date: t.service_date, due_at: t.due_at, earliest_start_at: t.earliest_start_at ?? undefined, arriving_booking_id: t.arriving_booking_id }, tz) : [],
    changeReason: pending?.reason ?? null,
  };
}

/** Thẻ một việc trên bảng điều phối. Không hiện tên khách — chỉ giờ đến và số khách. */
export function TaskCard({ task: t, tz, today, perms }: { task: TaskView; tz: string; today: string; perms: ActionPerms }) {
  const closed = t.status === "passed" || t.status === "cancelled";
  return (
    <article className={`${styles.task} ${t.kind === "turnover" && !closed ? styles.turnover : ""} ${t.overdue ? styles.overdue : ""}`}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Link href={`/cleaning/${t.id}`} className={styles.unit}>
          {t.unit_code}
        </Link>
        <span className="small muted">
          {t.unit_name} · {t.property_code}
        </span>
        <DemoBadge show={t.is_demo} />
      </div>
      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
        <Badge tone={t.kind === "turnover" ? "danger" : "neutral"}>{TASK_KIND_LABELS[t.kind] ?? t.kind}</Badge>
        <Badge tone={statusTone(t.status)}>{TASK_STATUS_LABELS[t.status] ?? t.status}</Badge>
        {t.overdue ? <Badge tone="danger">Quá hạn</Badge> : null}
        {t.change_ack_required ? <Badge tone="danger">Chờ xác nhận thay đổi</Badge> : null}
        {t.open_incidents ? <Badge tone={t.blocking_incidents ? "danger" : "warn"}>{t.open_incidents} sự cố mở{t.blocking_incidents ? " · chặn nhận khách" : ""}</Badge> : null}
        {t.service_date < today && !closed ? <Badge tone="warn">Từ ngày {formatDateVi(t.service_date)}</Badge> : null}
      </div>
      <dl className={styles.facts}>
        <dt>Sớm nhất</dt>
        <dd>{t.earliest_start_at ? formatInstant(t.earliest_start_at, tz) : "—"}</dd>
        <dt>HẠN</dt>
        <dd className="strong">{formatInstant(t.due_at, tz)}</dd>
        <dt>Khách đến</dt>
        <dd>
          {t.next_arrival_at ? (
            <>
              {formatInstant(t.next_arrival_at, tz)}
              {t.arriving_eta ? ` · ETA ${t.arriving_eta}` : ""} · {t.arriving_guests ?? "?"} khách
            </>
          ) : (
            <span className="faint">Chưa có khách đến tiếp</span>
          )}
        </dd>
        {!closed ? (
          <>
            <dt>Khách cũ</dt>
            <dd>{t.vacancy.ok ? <Badge tone="ok">Đã rời / không cần</Badge> : <Badge tone="warn">Chưa xác nhận đã rời</Badge>}</dd>
          </>
        ) : null}
        {t.checklist_total ? (
          <>
            <dt>Checklist</dt>
            <dd>
              {t.checklist_done}/{t.checklist_total}
            </dd>
          </>
        ) : null}
      </dl>
      <TaskActions task={toActionTask(t, tz)} perms={perms} />
    </article>
  );
}
