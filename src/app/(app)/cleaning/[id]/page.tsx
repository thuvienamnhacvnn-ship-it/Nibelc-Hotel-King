import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, DemoBadge, EmptyState, KeyValue, Notice, PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant, now } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { BOOKING_STATUS_LABELS, CHANNEL_LABELS, STAY_STATUS_LABELS } from "@/modules/booking/types";
import { type BookingBrief, INCIDENT_KIND_LABELS, INCIDENT_SEVERITY_LABELS, TASK_EVENT_LABELS, type TaskEventRow, getTaskDetail } from "@/modules/cleaning/queries";
import { TASK_KIND_LABELS, TASK_STATUS_LABELS } from "@/modules/cleaning/service";
import { getTaskEvidence } from "@/modules/photos/queries";
import styles from "../cleaning.module.css";
import { type ChangeValues, changeRows, statusTone } from "../_components/format";
import { ChangeTable, ResolveIncidentButton, TaskActions } from "../_components/task-actions";
import { toActionTask } from "../_components/task-card";
import { EvidenceSection, InspectionEvidenceNotice } from "./evidence";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chi tiết việc dọn" };

export default async function CleaningTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("cleaning.view_all");
  const { id } = await params;
  let detail;
  try {
    detail = await getTaskDetail(actor, id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const { task: t, checklist, events, incidents, departing, arriving, userNames } = detail;
  const tz = actor.timezone;
  const perms = { manage: can(actor, "cleaning.manage"), approve: can(actor, "readiness.approve") };
  const action = toActionTask(t, tz);
  const canBooking = can(actor, "booking.view");
  const pending = t.pending_change as (ChangeValues & { reason?: string }) | null;
  const evidence = await getTaskEvidence(actor, t.id);

  const groups = new Map<string, typeof checklist>();
  for (const item of checklist) {
    const key = item.category ?? "Chung";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return (
    <div className="stack">
      <div className="small">
        <Link href={`/cleaning?date=${t.service_date}`}>← Điều phối ngày {formatDateVi(t.service_date)}</Link>
      </div>
      <PageHeader
        title={
          <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            Việc dọn {t.unit_code} <Badge tone={statusTone(t.status)}>{TASK_STATUS_LABELS[t.status]}</Badge>
            {t.kind === "turnover" ? <Badge tone="danger">{TASK_KIND_LABELS[t.kind]}</Badge> : null}
            {t.overdue ? <Badge tone="danger">Quá hạn</Badge> : null}
            <DemoBadge show={t.is_demo} />
          </span>
        }
        description={`${t.unit_name} · ${t.property_code} — ${t.property_name}. Giờ hiển thị theo Budapest. Cập nhật ${formatInstant(now(), tz)}.`}
      />

      {t.change_ack_required && pending ? (
        <Notice tone="danger" title="Thay đổi đang chờ xác nhận">
          <div className="stack" style={{ gap: 6, marginTop: 4 }}>
            <div>Booking thay đổi khi việc đã được nhận hoặc đang làm. Cleaner hoặc điều phối phải xác nhận trước khi tiếp tục.{pending.reason ? ` Lý do: ${pending.reason}.` : ""}</div>
            <ChangeTable rows={action.changeRows ?? []} />
          </div>
        </Notice>
      ) : null}

      {!t.vacancy.ok && !["passed", "cancelled", "awaiting_inspection", "in_progress"].includes(t.status) ? (
        <Notice tone="warn" title="Chưa xác nhận khách cũ đã rời phòng">
          {t.vacancy.message}
        </Notice>
      ) : null}

      {t.status === "awaiting_inspection" ? <InspectionEvidenceNotice evidence={evidence} /> : null}

      {!perms.manage && !perms.approve ? <Notice tone="info">Chế độ chỉ xem — bạn không có quyền thao tác việc này.</Notice> : null}

      <Card title="Thông tin" actions={<TaskActions task={action} perms={perms} size="md" />}>
        <KeyValue
          items={[
            ["Loại việc", TASK_KIND_LABELS[t.kind] ?? t.kind],
            ["Ngày dọn", formatDateVi(t.service_date)],
            ["Sớm nhất bắt đầu", t.earliest_start_at ? formatInstant(t.earliest_start_at, tz) : "—"],
            ["Hạn hoàn thành", <strong key="due">{formatInstant(t.due_at, tz)}</strong>],
            ["Thời lượng ước tính", `${t.estimated_minutes} phút`],
            ["Người làm", t.assignee_name ?? <Badge tone="warn">Chưa phân công</Badge>],
            ["Khách cũ đã rời", t.vacancy.ok ? <Badge tone="ok">Đã xác nhận / không cần</Badge> : <Badge tone="warn">Chưa xác nhận</Badge>],
            ["Trạng thái phòng", t.readiness_label],
            ["Địa chỉ", t.property_address ?? <span className="faint">Chưa có địa chỉ trong danh mục</span>],
            ["Ghi chú", t.note ?? "—"],
          ]}
        />
      </Card>

      <div className="grid grid-2">
        <Card title="Khách rời phòng">
          <BookingBlock b={departing} tz={tz} canBooking={canBooking} role="departing" />
        </Card>
        <Card title="Khách đến tiếp">
          <BookingBlock b={arriving} tz={tz} canBooking={canBooking} role="arriving" arrivalAt={t.next_arrival_at} guests={t.arriving_guests} />
        </Card>
      </div>

      <Card title={`Checklist (${t.checklist_done}/${t.checklist_total})`}>
        {checklist.length === 0 ? (
          <EmptyState title="Việc này không có checklist" />
        ) : (
          [...groups.entries()].map(([group, items]) => (
            <div key={group} className={styles.checkGroup}>
              <h3>{group}</h3>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id}>
                        <td style={{ width: 32 }}>{i.checked ? <Badge tone="ok">✓</Badge> : <Badge tone="neutral">—</Badge>}</td>
                        <td>
                          {i.label}
                          {i.note ? <div className="small muted">Ghi chú: {i.note}</div> : null}
                        </td>
                        <td className="small muted">{i.checked ? `${i.checked_by_name ?? "—"} · ${formatInstant(i.checked_at, tz)}` : "Chưa làm"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </Card>

      <Card title={`Ảnh bằng chứng (${evidence.photos.length})`}>
        <EvidenceSection evidence={evidence} checklist={checklist} tz={tz} canReview={perms.manage || perms.approve} taskId={t.id} />
      </Card>

      <Card title={`Sự cố (${incidents.length})`} pad={false}>
        {incidents.length === 0 ? (
          <EmptyState title="Không có sự cố" />
        ) : (
          <div className={styles.list}>
            {incidents.map((i) => (
              <div key={i.id} className={styles.listRow}>
                <Badge tone={i.status === "resolved" ? "ok" : i.severity === "blocking" ? "danger" : "warn"}>
                  {i.status === "resolved" ? "Đã xử lý" : INCIDENT_SEVERITY_LABELS[i.severity]}
                </Badge>
                <span className="strong">{INCIDENT_KIND_LABELS[i.kind]}</span>
                {i.task_id !== t.id ? <span className="small faint">(cùng phòng, việc khác)</span> : null}
                <span style={{ flexBasis: "100%" }}>{i.description}</span>
                <span className="small faint">
                  Báo: {i.reported_by_name ?? "—"} · {formatInstant(i.created_at, tz)}
                  {i.resolved_at ? ` · Xử lý: ${i.resolved_by_name ?? "—"} · ${formatInstant(i.resolved_at, tz)}` : ""}
                </span>
                <span className="spacer" />
                {perms.manage && i.status !== "resolved" ? <ResolveIncidentButton incidentId={i.id} label={`${i.unit_code} — ${INCIDENT_KIND_LABELS[i.kind]}`} /> : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Lịch sử việc" pad={false}>
        {events.length === 0 ? (
          <EmptyState title="Chưa có sự kiện" />
        ) : (
          <ol className={styles.timeline}>
            {events.map((e) => (
              <li key={e.id}>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className="strong">{TASK_EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                  {e.from_status && e.to_status && e.from_status !== e.to_status ? (
                    <span className="small muted">
                      {TASK_STATUS_LABELS[e.from_status] ?? e.from_status} → {TASK_STATUS_LABELS[e.to_status] ?? e.to_status}
                    </span>
                  ) : null}
                  <span className="spacer" />
                  <span className="small faint">
                    {e.actor_name ?? (e.actor_type === "system" ? "Hệ thống" : e.actor_type)} · {formatInstant(e.created_at, tz)}
                  </span>
                </div>
                <EventDetail e={e} names={userNames} tz={tz} />
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function BookingBlock({
  b,
  tz,
  canBooking,
  role,
  arrivalAt,
  guests,
}: {
  b: BookingBrief | null;
  tz: string;
  canBooking: boolean;
  role: "departing" | "arriving";
  arrivalAt?: Date | null;
  guests?: number | null;
}) {
  if (!b) return <EmptyState title={role === "arriving" ? "Chưa có khách đến tiếp trong 7 ngày" : "Không gắn booking"} />;
  const ref = b.external_ref ?? "(không mã)";
  return (
    <KeyValue
      items={[
        [
          "Booking",
          <span key="b" className="row" style={{ gap: 6 }}>
            {canBooking ? <Link href={`/bookings/${b.id}`}>{ref}</Link> : ref} <span className="small faint">{CHANNEL_LABELS[b.source_channel] ?? b.source_channel}</span>
            <DemoBadge show={b.is_demo} />
          </span>,
        ],
        ...(b.guest_name !== undefined ? ([["Khách", b.guest_name ?? "—"]] as [string, string][]) : []),
        ["Ngày ở", `${formatDateVi(b.check_in_date)} → ${formatDateVi(b.check_out_date)}`],
        ["Trạng thái", `${BOOKING_STATUS_LABELS[b.booking_status] ?? b.booking_status} · ${STAY_STATUS_LABELS[b.stay_status] ?? b.stay_status}`],
        ...(role === "departing"
          ? ([["Trả muộn", b.late_checkout_time ? b.late_checkout_time.slice(0, 5) : "Không"]] as [string, string][])
          : ([
              ["Giờ đến", arrivalAt ? formatInstant(arrivalAt, tz) : "—"],
              ["ETA khách báo", b.eta_local ?? "Chưa rõ"],
              ["Số khách", String(guests ?? b.total_guests ?? "—")],
            ] as [string, string][])),
      ]}
    />
  );
}

function EventDetail({ e, names, tz }: { e: TaskEventRow; names: Record<string, string>; tz: string }) {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const name = (v: unknown) => (typeof v === "string" ? (names[v] ?? "người dùng khác") : "—");
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  switch (e.event_type) {
    case "assigned":
    case "reassigned":
      return (
        <div className="small">
          {d.from ? `${name(d.from)} → ` : ""}
          {text(d.toName) ?? name(d.to)}
        </div>
      );
    case "unassigned":
      return <div className="small">Bỏ khỏi {name(d.from)} · Lý do: {text(d.reason) ?? "—"}</div>;
    case "declined":
    case "cancelled":
    case "auto_cancelled":
      return <div className="small">Lý do: {text(d.reason) ?? "—"}</div>;
    case "vacancy_confirmed":
    case "inspection_failed":
    case "inspection_passed":
      return text(d.note) ? <div className="small">Ghi chú: {text(d.note)}</div> : null;
    case "incident_reported":
      return (
        <div className="small">
          {INCIDENT_KIND_LABELS[String(d.kind)] ?? String(d.kind)} · {INCIDENT_SEVERITY_LABELS[String(d.severity)] ?? String(d.severity)} — {text(d.description) ?? ""}
        </div>
      );
    case "rescheduled":
      return <ChangeTable rows={changeRows((d.after ?? {}) as ChangeValues, (d.before ?? {}) as ChangeValues, tz)} />;
    case "change_pending_ack":
      return (
        <div className="stack" style={{ gap: 4 }}>
          {text(d.reason) ? <div className="small">{text(d.reason)}</div> : null}
          <ChangeTable rows={changeRows(d as ChangeValues, null, tz)} />
        </div>
      );
    case "change_acknowledged":
      return <ChangeTable rows={changeRows((d.change ?? {}) as ChangeValues, null, tz)} />;
    default:
      return null;
  }
}
