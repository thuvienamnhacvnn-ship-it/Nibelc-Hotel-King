import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, DemoBadge, EmptyState, Notice, PageHeader, Stat } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant, todayOps } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANNEL_LABELS, STAY_STATUS_LABELS } from "@/modules/booking/types";
import { READINESS_LABELS, type ReadinessStatus } from "@/modules/cleaning/readiness";
import { TASK_STATUS_LABELS } from "@/modules/cleaning/service";
import { todayOverview } from "@/modules/overview/queries";
import { CONNECTOR_STATUS_LABELS, connectorTone } from "@/modules/connectors/labels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng quan hôm nay" };

export default async function TodayPage() {
  const actor = await requireActor();
  if (actor.role === "cleaner") redirect("/m");
  if (!can(actor, "booking.view") && !can(actor, "cleaning.view_all")) redirect("/khong-du-quyen");
  const date = todayOps(actor.timezone);
  const data = await todayOverview(actor, date);
  const showGuest = can(actor, "booking.view_guest_contact");

  return (
    <div className="stack">
      <PageHeader
        title="Tổng quan hôm nay"
        description={`Ngày vận hành ${formatDateVi(date)} theo giờ Budapest. Số booking và số phòng được đếm riêng; giờ nhận dự kiến không chứng minh khách đã đến.`}
        actions={
          <Link className="btn" href="/lich">
            Mở lịch phòng
          </Link>
        }
      />

      {data.pending.conflicts ? (
        <Notice tone="danger" title={`${data.pending.conflicts} xung đột lịch đang mở`}>
          Kênh bán đã nhận booking trùng đêm với khách khác. <Link href="/duyet">Xem và xử lý</Link>
        </Notice>
      ) : null}

      <div className="grid grid-4">
        <Stat label="Nhận phòng" value={data.counts.arrivalBookings} sub={`${data.counts.arrivalUnits} phòng/sản phẩm`} href="#den" />
        <Stat label="Trả phòng" value={data.counts.departureBookings} sub={`${data.counts.departureUnits} phòng/sản phẩm`} href="#di" />
        <Stat label="Ở tiếp" value={data.counts.stayoverBookings} sub={`${data.counts.stayoverUnits} phòng/sản phẩm`} href="#o-tiep" />
        <Stat label="Khách đến — phòng chưa sẵn sàng" value={data.notReady.length} tone={data.notReady.length ? "warn" : undefined} href="#chua-san-sang" />
        <Stat label="Việc dọn quá hạn" value={data.tasks.overdue} tone={data.tasks.overdue ? "danger" : undefined} href="/cleaning" />
        <Stat label="Việc chưa phân công" value={data.tasks.unassigned} tone={data.tasks.unassigned ? "warn" : undefined} sub="đến hết hôm nay" href="/cleaning" />
        <Stat label="Chờ duyệt thay đổi" value={data.pending.change_requests} href="/duyet" />
        <Stat label="Chờ kiểm phòng" value={data.tasks.awaiting_inspection} sub={data.tasks.needs_ack ? `${data.tasks.needs_ack} việc chờ xác nhận thay đổi` : undefined} href="/cleaning" />
      </div>

      <div className="grid grid-2">
        <Card title="Khách đến — phòng chưa sẵn sàng" pad={false}>
          <div id="chua-san-sang" />
          {data.notReady.length === 0 ? (
            <EmptyState title="Không có">Mọi phòng có khách đến hôm nay đã được duyệt sẵn sàng.</EmptyState>
          ) : (
            <MovementTable rows={data.notReady} showGuest={showGuest} extra={(r) => <Badge tone="warn">{READINESS_LABELS[r.readiness as ReadinessStatus]}</Badge>} />
          )}
        </Card>
        <Card title="Việc dọn quá hạn" pad={false}>
          {data.overdueTasks.length === 0 ? (
            <EmptyState title="Không có việc quá hạn" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Phòng</th>
                    <th>Trạng thái</th>
                    <th>Hạn</th>
                    <th>Người làm</th>
                  </tr>
                </thead>
                <tbody>
                  {data.overdueTasks.map((t) => (
                    <tr key={t.id}>
                      <td className="strong">
                        <Link href={`/cleaning/${t.id}`}>{t.unit_code}</Link>
                      </td>
                      <td>
                        <Badge tone="danger">{TASK_STATUS_LABELS[t.status]}</Badge>
                      </td>
                      <td>{formatInstant(t.due_at, actor.timezone)}</td>
                      <td>{t.assignee ?? <span className="faint">Chưa giao</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title={`Nhận phòng (${data.arrivals.length})`} pad={false}>
        <div id="den" />
        {data.arrivals.length ? <MovementTable rows={data.arrivals} showGuest={showGuest} /> : <EmptyState title="Không có khách nhận phòng hôm nay" />}
      </Card>
      <Card title={`Trả phòng (${data.departures.length})`} pad={false}>
        <div id="di" />
        {data.departures.length ? <MovementTable rows={data.departures} showGuest={showGuest} /> : <EmptyState title="Không có khách trả phòng hôm nay" />}
      </Card>
      <Card title={`Ở tiếp (${data.stayovers.length})`} pad={false}>
        <div id="o-tiep" />
        {data.stayovers.length ? <MovementTable rows={data.stayovers} showGuest={showGuest} /> : <EmptyState title="Không có khách ở tiếp" />}
      </Card>

      <Card title="Tình trạng đồng bộ kênh" actions={<Link href="/ket-noi">Chi tiết</Link>} pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Kết nối</th>
                <th>Trạng thái</th>
                <th>Đồng bộ thành công gần nhất</th>
                <th>Lỗi gần nhất</th>
              </tr>
            </thead>
            <tbody>
              {data.connectors.map((c) => (
                <tr key={c.id}>
                  <td className="strong">
                    {c.label} {c.status === "demo" ? <DemoBadge /> : null}
                  </td>
                  <td>
                    <Badge tone={connectorTone(c.status)}>{CONNECTOR_STATUS_LABELS[c.status]}</Badge>
                    {c.paused ? <Badge tone="warn">Tạm dừng</Badge> : null}
                  </td>
                  <td>{c.last_success_at ? formatInstant(c.last_success_at, actor.timezone) : <span className="faint">Chưa có</span>}</td>
                  <td className="small">{c.last_error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-pad small muted">
          Chưa có kênh thật nào được kết nối. Dữ liệu booking hiện đến từ nhập tay, nhập Excel và nguồn DEMO — không phản ánh trạng thái Airbnb/Booking.com theo thời gian thực.
        </div>
      </Card>
    </div>
  );
}

type Movement = Awaited<ReturnType<typeof todayOverview>>["arrivals"][number];

function MovementTable<T extends Movement>({ rows, showGuest, extra }: { rows: T[]; showGuest: boolean; extra?: (r: T) => React.ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Phòng</th>
            <th>Booking</th>
            {showGuest ? <th>Khách</th> : null}
            <th className="num">Số khách</th>
            <th>Giờ</th>
            <th>Lưu trú</th>
            {extra ? <th>Phòng</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.booking_id}-${r.unit_id}`}>
              <td>
                <span className="strong">{r.unit_code}</span> <span className="faint small">{r.property_code}</span>
              </td>
              <td>
                <Link href={`/bookings/${r.booking_id}`}>{r.external_ref ?? "(không mã)"}</Link> <span className="small faint">{CHANNEL_LABELS[r.source_channel]}</span> <DemoBadge show={r.is_demo} />
              </td>
              {showGuest ? <td>{r.guest_name ?? "—"}</td> : null}
              <td className="num">{r.guests ?? r.total_guests ?? "—"}</td>
              <td className="small">
                {r.kind === "arrival" ? `ETA ${r.eta_local ?? "chưa rõ"}${r.early_checkin_time ? ` · nhận sớm ${r.early_checkin_time.slice(0, 5)}` : ""}` : null}
                {r.kind === "departure" && r.late_checkout_time ? `trả muộn ${r.late_checkout_time.slice(0, 5)}` : null}
              </td>
              <td>
                <Badge tone={r.stay_status === "checked_in" ? "info" : r.stay_status === "checked_out" ? "ok" : "neutral"}>{STAY_STATUS_LABELS[r.stay_status]}</Badge>
              </td>
              {extra ? <td>{extra(r)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
