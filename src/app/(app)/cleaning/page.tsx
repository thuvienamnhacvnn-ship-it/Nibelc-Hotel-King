import Link from "next/link";
import { FilterPanel } from "@/components/client";
import { Badge, Card, DemoBadge, EmptyState, Notice, PageHeader } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { addDays, formatDateVi, formatInstant, isValidDate, localToUtc, now, todayOps, tzAbbrev, weekdayVi } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import {
  INCIDENT_KIND_LABELS,
  INCIDENT_SEVERITY_LABELS,
  type TaskView,
  awaitingInspection,
  cleanersForDay,
  listTasksForDay,
  openIncidents,
  propertyOptions,
} from "@/modules/cleaning/queries";
import { TASK_STATUS_LABELS } from "@/modules/cleaning/service";
import styles from "./cleaning.module.css";
import { TaskCard } from "./_components/task-card";
import { ResolveIncidentButton, TaskActions } from "./_components/task-actions";
import { toActionTask } from "./_components/task-card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Điều phối cleaning" };

type Search = Promise<{ date?: string; status?: string; property?: string }>;

export default async function CleaningBoardPage({ searchParams }: { searchParams: Search }) {
  const actor = await requireActor("cleaning.view_all");
  const sp = await searchParams;
  const today = todayOps(actor.timezone);
  const date = sp.date && isValidDate(sp.date) ? sp.date : today;
  const status = sp.status && TASK_STATUS_LABELS[sp.status] ? sp.status : "";
  const property = sp.property ?? "";
  const perms = { manage: can(actor, "cleaning.manage"), approve: can(actor, "readiness.approve") };
  const tz = actor.timezone;

  const [tasks, cleaners, properties, inspection, incidents] = await Promise.all([
    listTasksForDay(actor, { date, status, propertyId: property }),
    cleanersForDay(actor, date),
    propertyOptions(actor),
    awaitingInspection(actor),
    openIncidents(actor),
  ]);

  const qs = (d: string) => {
    const p = new URLSearchParams({ date: d });
    if (status) p.set("status", status);
    if (property) p.set("property", property);
    return `/cleaning?${p}`;
  };
  const openTasks = tasks.filter((t) => t.status !== "cancelled");
  const cancelled = tasks.filter((t) => t.status === "cancelled");
  const unassigned = openTasks.filter((t) => !t.assigned_to);
  const cleanerIds = new Set(cleaners.map((c) => c.user_id));
  const orphan = openTasks.filter((t) => t.assigned_to && !cleanerIds.has(t.assigned_to));
  const available = cleaners.filter((c) => c.shifts.length > 0 && c.tasks_that_day < c.max_tasks_per_day);
  const uncovered = unassigned.filter((t) => t.status === "pending_assignment");
  const dayTz = tzAbbrev(localToUtc(date, "12:00", tz), tz);

  return (
    <div className="stack">
      <PageHeader
        title="Dọn phòng"
        description={`${weekdayVi(date)} ${formatDateVi(date)}${date === today ? " · hôm nay (gồm việc tồn từ trước)" : ""} · giờ Budapest (${dayTz})`}
        actions={
          <>
            <Link className="btn" href={qs(addDays(date, -1))}>
              ← Trước
            </Link>
            <Link className="btn" href={qs(today)} aria-current={date === today ? "page" : undefined}>
              Hôm nay
            </Link>
            <Link className="btn" href={qs(addDays(date, 1))}>
              Sau →
            </Link>
          </>
        }
      />

      <div className="card">
      <FilterPanel active={(status ? 1 : 0) + (property ? 1 : 0)} label="Lọc ngày, trạng thái, nhà">
      <form className={styles.filters} method="get" action="/cleaning">
        <div className="field">
          <label htmlFor="f-date">Ngày</label>
          <input id="f-date" className="input" type="date" name="date" defaultValue={date} />
        </div>
        <div className="field">
          <label htmlFor="f-status">Trạng thái</label>
          <select id="f-status" className="select" name="status" defaultValue={status}>
            <option value="">Tất cả</option>
            {Object.entries(TASK_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-prop">Nhà</label>
          <select id="f-prop" className="select" name="property" defaultValue={property}>
            <option value="">Tất cả</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {p.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary">
          Lọc
        </button>
        {status || property ? (
          <Link className="btn" href={`/cleaning?date=${date}`}>
            Bỏ lọc
          </Link>
        ) : null}
        <span className="spacer" />
        <span className="small faint">Cập nhật {formatInstant(now(), tz)}</span>
      </form>
      </FilterPanel>
      </div>

      {!perms.manage && !perms.approve ? (
        <Notice tone="info" title="Chế độ chỉ xem">
          Bạn xem được việc dọn nhưng không có quyền giao việc, hủy hay kiểm phòng.
        </Notice>
      ) : null}

      {uncovered.length && available.length === 0 ? (
        <Notice tone="danger" title={`${uncovered.length} việc chưa được phủ`}>
          Không có cleaner nào có ca và còn chỗ trong ngày {formatDateVi(date)}. Hệ thống không tự giao — các việc này vẫn ở trạng thái “Chờ phân công”.
        </Notice>
      ) : null}

      <div className={styles.summaryBar}>
        <span className={styles.summaryChip}>
          <strong>{openTasks.length}</strong> việc
        </span>
        <span className={styles.summaryChip}>
          <strong>{unassigned.length}</strong> chưa giao
        </span>
        <span className={styles.summaryChip}>
          <strong>{inspection.length}</strong> chờ kiểm
        </span>
        <span className={styles.summaryChip}>
          <strong>{incidents.length}</strong> sự cố
        </span>
      </div>

      {inspection.length || incidents.length ? (
      <div className="grid grid-2">
        <Card title={`Chờ kiểm (${inspection.length})`} pad={false}>
          {inspection.length === 0 ? (
            <EmptyState title="Không có phòng chờ kiểm" />
          ) : (
            <div className={styles.list}>
              {inspection.map((t) => (
                <div key={t.id} className={styles.listRow}>
                  <Link href={`/cleaning/${t.id}`} className="strong">
                    {t.unit_code}
                  </Link>
                  <span className="small muted">{t.property_code}</span>
                  <DemoBadge show={t.is_demo} />
                  <span className="small">
                    {t.assignee_name ?? "—"} · hạn {formatInstant(t.due_at, tz)}
                  </span>
                  {t.next_arrival_at ? <span className="small">· khách đến {formatInstant(t.next_arrival_at, tz)}</span> : null}
                  {t.blocking_incidents ? <Badge tone="danger">Sự cố chặn nhận khách</Badge> : null}
                  <span className="spacer" />
                  {perms.approve ? <TaskActions task={toActionTask(t, tz)} perms={{ manage: false, approve: true }} /> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title={`Sự cố đang mở (${incidents.length})`} pad={false}>
          {incidents.length === 0 ? (
            <EmptyState title="Không có sự cố đang mở" />
          ) : (
            <div className={styles.list}>
              {incidents.map((i) => (
                <div key={i.id} className={styles.listRow}>
                  <span className="strong">{i.unit_code}</span>
                  <span className="small muted">{i.property_code}</span>
                  <Badge tone={i.severity === "blocking" ? "danger" : i.severity === "low" ? "neutral" : "warn"}>{INCIDENT_SEVERITY_LABELS[i.severity]}</Badge>
                  <span className="small">{INCIDENT_KIND_LABELS[i.kind]}</span>
                  <span className="small" style={{ flexBasis: "100%" }}>
                    {i.description}
                  </span>
                  <span className="small faint">
                    {i.reported_by_name ?? "—"} · {formatInstant(i.created_at, tz)}
                    {i.task_id ? (
                      <>
                        {" · "}
                        <Link href={`/cleaning/${i.task_id}`}>xem việc</Link>
                      </>
                    ) : null}
                  </span>
                  <span className="spacer" />
                  {perms.manage ? <ResolveIncidentButton incidentId={i.id} label={`${i.unit_code} — ${INCIDENT_KIND_LABELS[i.kind]}`} /> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      ) : null}

      {tasks.length === 0 ? (
        <Card>
          <EmptyState title={`Không có việc dọn ngày ${formatDateVi(date)}${status || property ? " với bộ lọc này" : ""}`}>
            Việc dọn tự lập từ lượt trả phòng của booking.
          </EmptyState>
        </Card>
      ) : (
        <div className={styles.board}>
          <section className={`${styles.column} ${unassigned.length ? styles.unassigned : ""}`}>
            <div className={styles.columnHead}>
              <h2>Chưa phân công ({unassigned.length})</h2>
              <span className="small">{unassigned.length ? (available.length ? `${available.length} người còn nhận được việc` : "Không còn người khả dụng") : "Đã giao hết"}</span>
            </div>
            {unassigned.length ? unassigned.map((t) => <TaskCard key={t.id} task={t} tz={tz} today={today} perms={perms} />) : <div className="small muted">Không có việc chờ giao.</div>}
          </section>
          {cleaners.map((c) => {
            const mine = openTasks.filter((t) => t.assigned_to === c.user_id);
            const full = c.tasks_that_day >= c.max_tasks_per_day;
            return (
              <section key={c.user_id} className={styles.column}>
                <div className={styles.columnHead}>
                  <div className="row" style={{ gap: 6 }}>
                    <h2>{c.full_name}</h2>
                    <DemoBadge show={c.is_demo} />
                  </div>
                  <div className="small faint">
                    {c.shifts.length ? `Ca ${c.shifts.join(", ")}` : <span style={{ color: "var(--warn)" }}>Không có ca</span>} ·{" "}
                    <span style={full ? { color: "var(--danger)", fontWeight: 700 } : undefined}>
                      {c.tasks_that_day}/{c.max_tasks_per_day} việc
                    </span>
                  </div>
                </div>
                {mine.length ? mine.map((t) => <TaskCard key={t.id} task={t} tz={tz} today={today} perms={perms} />) : <div className="small muted">Chưa có việc.</div>}
              </section>
            );
          })}
          {orphan.length ? (
            <section className={styles.column}>
              <div className={styles.columnHead}>
                <h2>Giao cho người không còn hoạt động ({orphan.length})</h2>
                <span className="small">Cần giao lại.</span>
              </div>
              {orphan.map((t) => (
                <TaskCard key={t.id} task={t} tz={tz} today={today} perms={perms} />
              ))}
            </section>
          ) : null}
        </div>
      )}

      {cancelled.length ? (
        <details className="card card-pad">
          <summary className="strong">Đã hủy ({cancelled.length})</summary>
          <div className={styles.board} style={{ marginTop: 10 }}>
            {cancelled.map((t: TaskView) => (
              <TaskCard key={t.id} task={t} tz={tz} today={today} perms={perms} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
