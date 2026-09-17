import Link from "next/link";
import { Badge, DemoBadge } from "@/components/ui";
import { formatDateVi, formatInstant, localDateOf, localTimeOf } from "@/lib/time";
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
  // Giờ gọn: cùng ngày đang xem thì chỉ hiện giờ, khác ngày thì thêm ngày/tháng.
  const when = (d: Date | string | null) => {
    if (!d) return null;
    const x = typeof d === "string" ? new Date(d) : d;
    const day = localDateOf(x, tz);
    return day === today ? localTimeOf(x, tz) : `${formatDateVi(day).slice(0, 5)} ${localTimeOf(x, tz)}`;
  };
  return (
    <article className={`${styles.task} ${t.kind === "turnover" && !closed ? styles.turnover : ""} ${t.overdue ? styles.overdue : ""}`}>
      <div className={styles.taskHead}>
        <Link href={`/cleaning/${t.id}`} className={styles.unit}>
          {t.unit_code}
        </Link>
        <span className={`small faint ${styles.taskName}`}>{t.unit_name}</span>
        <DemoBadge show={t.is_demo} />
        <Badge tone={statusTone(t.status)}>{TASK_STATUS_LABELS[t.status] ?? t.status}</Badge>
      </div>
      <div className={styles.taskTimes} title={t.earliest_start_at ? `Bắt đầu sớm nhất ${formatInstant(t.earliest_start_at, tz)}` : undefined}>
        <span>
          <span className="faint">Hạn</span> <strong>{when(t.due_at)}</strong>
        </span>
        {t.next_arrival_at ? (
          <span>
            <span className="faint">Khách đến</span> {when(t.next_arrival_at)}
            {t.arriving_eta ? ` (ETA ${t.arriving_eta})` : ""} · {t.arriving_guests ?? "?"} khách
          </span>
        ) : null}
      </div>
      {t.overdue || t.kind === "turnover" || t.change_ack_required || t.open_incidents || (!closed && !t.vacancy.ok) || (t.checklist_total && t.checklist_done) ? (
        <div className={styles.flags}>
          {t.overdue && !closed ? <Badge tone="danger">Quá hạn</Badge> : null}
          {t.kind === "turnover" && !closed ? <Badge tone="warn">{TASK_KIND_LABELS[t.kind]}</Badge> : null}
          {t.change_ack_required ? <Badge tone="danger">Chờ xác nhận thay đổi</Badge> : null}
          {t.open_incidents ? <Badge tone={t.blocking_incidents ? "danger" : "warn"}>{t.open_incidents} sự cố{t.blocking_incidents ? " · chặn nhận khách" : ""}</Badge> : null}
          {!closed && !t.vacancy.ok ? <span className="small faint">Chưa xác nhận khách cũ đã rời</span> : null}
          {t.checklist_total && t.checklist_done ? <span className="small faint">Checklist {t.checklist_done}/{t.checklist_total}</span> : null}
        </div>
      ) : null}
      <TaskActions task={toActionTask(t, tz)} perms={perms} />
    </article>
  );
}
