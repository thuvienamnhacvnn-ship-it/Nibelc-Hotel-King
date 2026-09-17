import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Badge, Card, DemoBadge, PageHeader, Stat } from "@/components/ui";
import { callName } from "@/lib/names";
import { requireActor } from "@/lib/session";
import { formatDateVi, todayOps, weekdayVi } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANNEL_LABELS, STAY_STATUS_LABELS } from "@/modules/booking/types";
import { READINESS_LABELS, type ReadinessStatus } from "@/modules/cleaning/readiness";
import { todayOverview } from "@/modules/overview/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng quan" };

type Movement = Awaited<ReturnType<typeof todayOverview>>["arrivals"][number];

export default async function TodayPage() {
  const actor = await requireActor();
  if (actor.role === "cleaner") redirect("/m");
  if (!can(actor, "booking.view") && !can(actor, "cleaning.view_all")) redirect("/khong-du-quyen");
  const date = todayOps(actor.timezone);
  const data = await todayOverview(actor, date);
  const showGuest = can(actor, "booking.view_guest_contact");
  const canBooking = can(actor, "booking.view");
  const canCleaning = can(actor, "cleaning.view_all");

  const firstName = callName(actor.fullName);
  const units = (codes: string[]) => (codes.length > 4 ? `${codes.slice(0, 4).join(", ")} +${codes.length - 4}` : codes.join(", "));

  // Việc cần xử lý: chỉ hiện mục có số > 0, xếp theo mức khẩn.
  const todos: { key: string; count: number; label: string; sub?: string; href?: string; tone: "danger" | "warn" | "neutral" }[] = [
    { key: "conflicts", count: data.pending.conflicts, label: "Xung đột lịch đang mở", sub: "Kênh bán nhận booking trùng đêm", href: canBooking ? "/duyet" : undefined, tone: "danger" as const },
    { key: "overdue", count: data.tasks.overdue, label: "Việc dọn quá hạn", sub: units(data.overdueTasks.map((t) => t.unit_code)), href: canCleaning ? "/cleaning" : undefined, tone: "danger" as const },
    { key: "notReady", count: data.notReady.length, label: "Khách đến nhưng phòng chưa sẵn sàng", sub: units(data.notReady.map((r) => r.unit_code)), href: canCleaning ? "/cleaning" : undefined, tone: "warn" as const },
    { key: "incidents", count: data.pending.incidents, label: "Sự cố phòng chưa xử lý", href: canCleaning ? "/cleaning" : undefined, tone: "warn" as const },
    { key: "unassigned", count: data.tasks.unassigned, label: "Việc dọn chưa phân công", href: canCleaning ? "/cleaning" : undefined, tone: "warn" as const },
    { key: "changes", count: data.pending.change_requests, label: "Thay đổi booking chờ duyệt", href: canBooking ? "/duyet" : undefined, tone: "neutral" as const },
    { key: "inspect", count: data.tasks.awaiting_inspection, label: "Phòng chờ kiểm", href: canCleaning ? "/cleaning" : undefined, tone: "neutral" as const },
    { key: "ack", count: data.tasks.needs_ack, label: "Thay đổi chờ người dọn xác nhận", href: canCleaning ? "/cleaning" : undefined, tone: "neutral" as const },
  ].filter((t) => t.count > 0);
  const urgent = todos.filter((t) => t.tone === "danger").reduce((s, t) => s + t.count, 0);
  const totalTodo = todos.reduce((s, t) => s + t.count, 0);
  const realConnectors = data.connectors.filter((c) => c.status !== "demo" && c.status !== "not_configured" && c.status !== "testing");

  return (
    <div className="stack">
      {/* Điện thoại: lời chào + tóm tắt ngày + lối tắt */}
      <section className="show-mobile hero">
        <div className="hero-date">
          {weekdayVi(date)} · {formatDateVi(date)} · Budapest
        </div>
        <div className="hero-hello">Chào {firstName}</div>
        <div className="hero-summary">
          {data.counts.arrivalBookings} khách đến · {data.counts.departureBookings} khách đi · {data.counts.stayoverBookings} ở tiếp
        </div>
        <div className={`hero-status ${totalTodo ? "warn" : "ok"}`}>{totalTodo ? `${totalTodo} việc cần xử lý` : "Mọi thứ đang ổn"}</div>
      </section>

      <div className="hide-mobile">
        <PageHeader
          title={`Chào ${firstName}`}
          description={`${weekdayVi(date)}, ${formatDateVi(date)} · ngày vận hành theo giờ Budapest`}
          actions={
            <>
              {can(actor, "calendar.view") ? (
                <Link className="btn" href="/lich">
                  Lịch phòng
                </Link>
              ) : null}
              {can(actor, "booking.create") ? (
                <Link className="btn btn-primary" href="/bookings/moi">
                  Tạo booking
                </Link>
              ) : null}
            </>
          }
        />
      </div>

      <div className="kpi-row hide-mobile">
        <Stat label="Nhận phòng" value={data.counts.arrivalBookings} sub={`${data.counts.arrivalUnits} phòng`} href="#hom-nay" />
        <Stat label="Trả phòng" value={data.counts.departureBookings} sub={`${data.counts.departureUnits} phòng`} href="#hom-nay" />
        <Stat label="Ở tiếp" value={data.counts.stayoverBookings} sub={`${data.counts.stayoverUnits} phòng`} href="#hom-nay" />
        <Stat label="Cần xử lý" value={totalTodo} sub={urgent ? `${urgent} việc khẩn` : totalTodo ? "không có việc khẩn" : "đã xong hết"} tone={urgent ? "danger" : totalTodo ? "warn" : undefined} href="#can-xu-ly" />
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Cần xử lý" pad={false}>
          <div id="can-xu-ly" />
          {todos.length === 0 ? (
            <div className="todo-done">✓ Không có việc tồn đọng</div>
          ) : (
            <ul className="todo-list">
              {todos.map((t) => {
                const body = (
                  <>
                    <span className={`todo-count ${t.tone}`}>{t.count}</span>
                    <span className="todo-label">
                      {t.label}
                      {t.sub ? <span className="todo-sub">{t.sub}</span> : null}
                    </span>
                    {t.href ? <ChevronRight size={18} className="todo-arrow" aria-hidden /> : null}
                  </>
                );
                return (
                  <li key={t.key}>
                    {t.href ? (
                      <Link href={t.href} className="todo-item">
                        {body}
                      </Link>
                    ) : (
                      <div className="todo-item">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Khách hôm nay" pad={false}>
          <div id="hom-nay" />
          <MovementGroup title="Nhận phòng" rows={data.arrivals} showGuest={showGuest} canBooking={canBooking} notReady={new Map(data.notReady.map((r) => [r.unit_id, r.readiness as ReadinessStatus]))} />
          <MovementGroup title="Trả phòng" rows={data.departures} showGuest={showGuest} canBooking={canBooking} />
          <MovementGroup title="Ở tiếp" rows={data.stayovers} showGuest={showGuest} canBooking={canBooking} />
        </Card>
      </div>

      {can(actor, "connector.view") && realConnectors.length === 0 ? (
        <div className="small faint">
          Chưa kết nối kênh bán thật — booking hiện đến từ nhập tay, Excel và nguồn DEMO. <Link href="/ket-noi">Kết nối kênh</Link>
        </div>
      ) : null}
    </div>
  );
}

function MovementGroup({ title, rows, showGuest, canBooking, notReady }: { title: string; rows: Movement[]; showGuest: boolean; canBooking: boolean; notReady?: Map<string, ReadinessStatus> }) {
  return (
    <section>
      <div className="card-subhead">
        {title} <span className="faint">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="mini-empty">Không có</div>
      ) : (
        <ul className="mini-list">
          {rows.map((r) => {
            const readiness = notReady?.get(r.unit_id);
            const body: ReactNode = (
              <>
                <span className="mini-unit">{r.unit_code}</span>
                <span className="mini-main">
                  <div>{showGuest && r.guest_name ? r.guest_name : (r.external_ref ?? "(không mã)")}</div>
                  <div className="mini-sub">
                    {CHANNEL_LABELS[r.source_channel] ?? r.source_channel} · {r.guests ?? r.total_guests ?? "?"} khách
                    {r.kind === "arrival" && r.eta_local ? ` · ETA ${r.eta_local}` : ""}
                    {r.kind === "arrival" && r.early_checkin_time ? ` · nhận sớm ${r.early_checkin_time.slice(0, 5)}` : ""}
                    {r.kind === "departure" && r.late_checkout_time ? ` · trả muộn ${r.late_checkout_time.slice(0, 5)}` : ""}
                  </div>
                </span>
                {readiness ? <Badge tone="warn">{READINESS_LABELS[readiness]}</Badge> : r.stay_status !== "expected" ? <Badge tone={r.stay_status === "checked_in" ? "info" : "ok"}>{STAY_STATUS_LABELS[r.stay_status]}</Badge> : null}
                <DemoBadge show={r.is_demo} />
              </>
            );
            return (
              <li key={`${r.booking_id}-${r.unit_id}`}>
                {canBooking ? (
                  <Link href={`/bookings/${r.booking_id}`} className="mini-row">
                    {body}
                  </Link>
                ) : (
                  <div className="mini-row">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
