import Link from "next/link";
import { Badge, DemoBadge } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { formatInstant, now } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { type TaskView, myTasks } from "@/modules/cleaning/queries";
import { TASK_KIND_LABELS, TASK_STATUS_LABELS } from "@/modules/cleaning/service";
import { statusTone } from "../../(app)/cleaning/_components/format";
import styles from "../mobile.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Việc của tôi" };

export default async function MyTasksPage() {
  const actor = await requireActor(["cleaning.own", "cleaning.view_all"]);
  const data = await myTasks(actor);
  const tz = actor.timezone;
  const total = data.today.length + data.reclean.length + data.upcoming.length + data.waiting.length;

  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <span className="small strong muted">Cập nhật {formatInstant(now(), tz)}</span>
        <span className="spacer" />
        <Link href="/m" className={`btn ${styles.logout}`}>
          Tải lại
        </Link>
      </div>

      {!can(actor, "cleaning.own") ? (
        <div className="notice notice-info strong">
          Bạn đang xem màn hình cleaner với vai trò điều phối — chỉ hiện việc giao cho chính bạn. <Link href="/cleaning">Mở bảng điều phối</Link>
        </div>
      ) : null}

      {total === 0 ? (
        <div className={styles.card}>
          <div className={styles.unit}>Chưa có việc</div>
          <div className={styles.line}>Hiện chưa có việc nào giao cho bạn. Điều phối giao việc thì việc sẽ hiện ở đây.</div>
        </div>
      ) : null}

      <Section title="Cần làm lại" tasks={data.reclean} tz={tz} />
      <Section title="Hôm nay" tasks={data.today} tz={tz} empty={total ? "Không còn việc hôm nay." : undefined} />
      <Section title="Sắp tới" tasks={data.upcoming} tz={tz} />
      <Section title="Đã gửi — chờ kiểm phòng" tasks={data.waiting} tz={tz} />
    </>
  );
}

function Section({ title, tasks, tz, empty }: { title: string; tasks: TaskView[]; tz: string; empty?: string }) {
  if (!tasks.length && !empty) return null;
  return (
    <section className={styles.group}>
      <h2 className={styles.sectionTitle}>
        {title} ({tasks.length})
      </h2>
      {tasks.length === 0 ? <div className="strong muted">{empty}</div> : null}
      {tasks.map((t) => (
        <Link key={t.id} href={`/m/viec/${t.id}`} className={`${styles.card} ${t.change_ack_required || t.overdue || t.status === "needs_reclean" ? styles.cardUrgent : ""}`}>
          <div className="row" style={{ gap: 8 }}>
            <span className={styles.unit}>{t.unit_code}</span>
            <span className="spacer" />
            <DemoBadge show={t.is_demo} />
          </div>
          <div className={styles.line}>
            {t.property_name}
            {t.property_address ? ` · ${t.property_address}` : ""}
          </div>
          <div className={styles.due}>
            Hạn: {formatInstant(t.due_at, tz)}
          </div>
          {t.next_arrival_at ? (
            <div className={styles.line}>
              Khách đến {formatInstant(t.next_arrival_at, tz)} · {t.arriving_guests ?? "?"} khách
            </div>
          ) : null}
          <div className={styles.badges}>
            <Badge tone={statusTone(t.status)}>{TASK_STATUS_LABELS[t.status]}</Badge>
            <Badge tone={t.kind === "turnover" ? "danger" : "neutral"}>{TASK_KIND_LABELS[t.kind]}</Badge>
            {t.change_ack_required ? <Badge tone="danger">Có thay đổi — cần xác nhận</Badge> : null}
            {t.overdue ? <Badge tone="danger">Quá hạn</Badge> : null}
            {t.status === "accepted" && !t.vacancy.ok ? <Badge tone="warn">Chưa xác nhận khách rời</Badge> : null}
            {t.checklist_total > 0 && t.status === "in_progress" ? (
              <Badge tone="info">
                Checklist {t.checklist_done}/{t.checklist_total}
              </Badge>
            ) : null}
          </div>
        </Link>
      ))}
    </section>
  );
}
