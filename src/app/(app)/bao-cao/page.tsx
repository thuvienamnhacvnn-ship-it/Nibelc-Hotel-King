import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, KeyValue, Notice, PageHeader, Stat } from "@/components/ui";
import { isUuid } from "@/lib/http";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant, localTimeOf, now, todayOps, tzAbbrev } from "@/lib/time";
import { READINESS_LABELS, type ReadinessStatus } from "@/modules/cleaning/readiness";
import { TASK_STATUS_LABELS } from "@/modules/cleaning/service";
import { CONNECTOR_STATUS_LABELS, connectorTone } from "@/modules/connectors/labels";
import { CHANGE_KIND_LABELS } from "@/modules/booking/types";
import { getReport, latestReportFor, listReports } from "@/modules/manager/queries";
import { REPORT_KIND_LABELS, STALE_SYNC_HOURS, type DailyReportData, reportWhatsAppPreview } from "@/modules/manager/report";
import { orgInfo } from "@/modules/system/queries";
import { CopyPreview, GenerateReportForm } from "./actions";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Báo cáo ngày" };

type SP = Promise<Record<string, string | string[] | undefined>>;

const REPORT_STATUS: Record<string, [string, "neutral" | "ok" | "info" | "warn"]> = {
  draft: ["Nháp", "neutral"],
  approved: ["Đã duyệt", "ok"],
  sent: ["Đã gửi", "info"],
  superseded: ["Đã có bản mới hơn", "warn"],
};

const sum = (o: Record<string, number>) => Object.values(o).reduce((s, n) => s + n, 0);

export default async function ReportsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("reports.view");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const today = todayOps(actor.timezone);
  const defaultKind = Number(localTimeOf(now(), actor.timezone).slice(0, 2)) >= 14 ? "evening" : "morning";

  let selectedId = str("id");
  if (!selectedId && str("date") && str("kind")) selectedId = (await latestReportFor(actor, str("date")!, str("kind")!))?.id ?? null;
  const [reports, org] = await Promise.all([listReports(actor), orgInfo(actor.orgId)]);
  if (!selectedId && reports[0]) selectedId = reports[0].id;
  const report = selectedId && isUuid(selectedId) ? await getReport(actor, selectedId) : null;

  return (
    <div className="stack">
      <PageHeader
        title={
          <>
            Báo cáo ngày <DemoBadge show={!!org?.is_demo} />
          </>
        }
        description={`Agent Manager lập cho Ngọc và Dịu. Mọi số liệu tính bằng truy vấn trên dữ liệu trong hệ thống; phần diễn giải sinh từ chính các số đó. Giờ theo Europe/Budapest (${tzAbbrev(now(), actor.timezone)}).`}
      />

      <Card title="Lập báo cáo">
        <GenerateReportForm defaultDate={today} defaultKind={defaultKind} />
        <div className="small muted" style={{ marginTop: 8 }}>
          Lịch tự lập 08:00 (đầu ngày) và 20:00 (cuối ngày) là <strong>đề xuất</strong>, cần Ngọc/Dịu chốt — cấu hình ở <Link href="/agent-center?tab=dang-ky">Agent Center › Đăng ký báo cáo</Link>, mặc định tắt.
        </div>
      </Card>

      <div className={styles.split}>
        <div className="stack">
          {str("id") && !report ? <Notice tone="warn" title="Không tìm thấy báo cáo này" /> : null}
          {report ? <ReportView report={report} timezone={actor.timezone} /> : <EmptyState title="Chưa có báo cáo nào">Chọn ngày, loại rồi bấm “Lập báo cáo”.</EmptyState>}
        </div>
        <Card title="Các bản đã lập" pad={false}>
          {reports.length === 0 ? (
            <EmptyState title="Chưa có" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id} className={r.id === report?.id ? styles.active : undefined}>
                      <td>
                        <Link href={`/bao-cao?id=${r.id}`} className="strong">
                          {REPORT_KIND_LABELS[r.kind]} {formatDateVi(r.ops_date)}
                        </Link>
                        <div className="small faint">
                          chốt {formatInstant(r.cutoff_at, actor.timezone)} · {r.generated_by_name ?? "hệ thống"}
                        </div>
                        <Badge tone={REPORT_STATUS[r.status]?.[1] ?? "neutral"}>{REPORT_STATUS[r.status]?.[0] ?? r.status}</Badge>{" "}
                        {r.sources_failed ? <Badge tone="danger">{r.sources_failed} nguồn lỗi</Badge> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function ReportView({ report, timezone }: { report: NonNullable<Awaited<ReturnType<typeof getReport>>>; timezone: string }) {
  const d: DailyReportData = report.data;
  const tickets = sum(d.support.ticketsOpen);
  const handoffs = sum(d.support.handoffsOpen);
  const staleConnectors = d.connectors.filter((c) => c.stale);
  const preview = reportWhatsAppPreview(d);
  return (
    <>
      <Card
        title={
          <>
            {REPORT_KIND_LABELS[report.kind]} — {formatDateVi(report.ops_date)} <Badge tone={REPORT_STATUS[report.status]?.[1] ?? "neutral"}>{REPORT_STATUS[report.status]?.[0] ?? report.status}</Badge>
          </>
        }
      >
        <div className="stack">
          <KeyValue
            items={[
              ["Thời điểm chốt dữ liệu", formatInstant(report.cutoff_at, timezone)],
              ["Cửa sổ “24 giờ qua”", `${formatInstant(d.windowFrom, timezone)} → ${formatInstant(d.cutoffAt, timezone)}`],
              ["Người lập", report.generated_by_name ?? "Hệ thống (lịch tự động)"],
              ["Múi giờ", d.timezone],
            ]}
          />
          {d.sourcesFailed.length ? (
            <Notice tone="danger" title="Có nguồn dữ liệu lỗi khi lập báo cáo">
              Các mục sau đang hiện 0 nhưng KHÔNG phải số thật: {d.sourcesFailed.map((s) => s.section).join(", ")}. Lập lại báo cáo sau khi sửa.
            </Notice>
          ) : null}
          {staleConnectors.length ? (
            <Notice tone="warn" title="Dữ liệu có thể cũ">
              {staleConnectors.map((c) => c.label).join(", ")} đang lỗi hoặc không đồng bộ thành công quá {STALE_SYNC_HOURS} giờ. <Link href="/ket-noi">Xem kết nối</Link>
            </Notice>
          ) : null}
          {report.kind === "morning" ? <Notice tone="info">Báo cáo đầu ngày là lịch theo booking — không chứng minh khách đã đến hay đã rời.</Notice> : null}
        </div>
      </Card>

      <div className="grid grid-3">
        <Stat label="Nhận phòng" value={d.movement.arrivals.bookings} sub={`booking · ${d.movement.arrivals.units} phòng`} href="/lich" />
        <Stat label="Trả phòng" value={d.movement.departures.bookings} sub={`booking · ${d.movement.departures.units} phòng`} href="/lich" />
        <Stat label="Ở tiếp" value={d.movement.stayovers.bookings} sub={`booking · ${d.movement.stayovers.units} phòng${d.movement.roomMoves ? ` · ${d.movement.roomMoves} đổi phòng` : ""}`} href="/lich" />
        <Stat label="Booking mới (24h)" value={d.last24h.newBookings.bookings} sub={`${d.last24h.newBookings.units} phòng · ${d.last24h.changeEvents} lượt thay đổi khác`} href="/bookings" />
        <Stat label="Hủy đã xác nhận (24h)" value={d.last24h.cancelledBookings.bookings} sub={`${d.last24h.cancelledBookings.units} phòng`} href="/bookings" />
        <Stat label="Yêu cầu đổi đang chờ" value={d.pendingChangeRequests.total} tone={d.pendingChangeRequests.total ? "warn" : undefined} href="/duyet" />
        <Stat label="Việc dọn quá hạn" value={d.cleaning.overdue} tone={d.cleaning.overdue ? "danger" : undefined} href="/cleaning" />
        <Stat label="Khách đến — phòng chưa sẵn sàng" value={d.arrivalsNotReady.units} sub={`${d.arrivalsNotReady.bookings} booking`} tone={d.arrivalsNotReady.units ? "warn" : undefined} href="/cleaning" />
        <Stat label="Sự cố mở" value={d.incidents.open} sub={d.incidents.blocking ? `${d.incidents.blocking} chặn việc` : undefined} tone={d.incidents.blocking ? "danger" : undefined} href="/cleaning" />
        <Stat label="Xung đột mở" value={d.decisions.conflicts} sub={`${d.conflicts.inventoryOpen} tồn · ${d.conflicts.calendarFindingsOpen} lệch lịch kênh`} tone={d.decisions.conflicts ? "danger" : undefined} href="/duyet" />
        <Stat label="Ticket mở" value={tickets} sub={`${d.support.ticketsOverdue} quá hạn nhận · ${handoffs} chờ chuyển người`} tone={d.support.ticketsOverdue ? "danger" : undefined} href="/hop-thu" />
        <Stat label="Hội thoại chưa đọc" value={d.support.conversationsUnread} href="/hop-thu" />
      </div>

      <Card title="Diễn giải (sinh từ số liệu, không dùng AI)">
        <div style={{ whiteSpace: "pre-wrap" }}>{report.narrative}</div>
      </Card>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title={`Việc dọn theo người (${d.cleaning.total})`} pad={false}>
          {d.cleaning.byPerson.length === 0 ? (
            <EmptyState title="Không có việc dọn trong ngày" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Người</th>
                    <th>Trạng thái</th>
                    <th className="num">Tổng</th>
                  </tr>
                </thead>
                <tbody>
                  {d.cleaning.byPerson.map((p) => (
                    <tr key={p.userId ?? "none"}>
                      <td className="strong">{p.userId ? p.name : <span className="faint">Chưa phân công</span>}</td>
                      <td className="small">
                        {Object.entries(p.byStatus)
                          .map(([s, n]) => `${n} ${TASK_STATUS_LABELS[s] ?? s}`)
                          .join(" · ")}
                      </td>
                      <td className="num">{p.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-pad small muted">
            Chờ kiểm {d.cleaning.awaitingInspection} · phải dọn lại {d.cleaning.needsReclean} · ảnh bị gắn cờ {d.cleaning.flaggedPhotos}
          </div>
        </Card>

        <Card title="Cần quyết định">
          <KeyValue
            items={[
              [<Link key="cr" href="/duyet">Thay đổi booking chờ duyệt</Link>, d.decisions.changeRequests],
              [<Link key="cf" href="/duyet">Xung đột tồn / lệch lịch kênh</Link>, d.decisions.conflicts],
              [<Link key="qa" href="/kho-qa">Câu Q&amp;A chờ duyệt</Link>, d.decisions.qaPendingReview],
              [<Link key="tp" href="/agent-center?tab=mau-tin">Mẫu tin nháp</Link>, d.decisions.templatesDraft],
              [<Link key="rf" href="/hop-thu">Yêu cầu tiền / hoàn tiền mở</Link>, d.decisions.refundTickets],
            ]}
          />
          {d.pendingChangeRequests.total ? (
            <div className="small muted" style={{ marginTop: 8 }}>
              Theo loại:{" "}
              {Object.entries(d.pendingChangeRequests.byKind)
                .map(([k, n]) => `${n} ${CHANGE_KIND_LABELS[k] ?? k}`)
                .join(" · ")}
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Khách đến — phòng chưa sẵn sàng" pad={false}>
          {d.arrivalsNotReady.items.length === 0 ? (
            <EmptyState title="Không có">Mọi phòng có khách đến đã được duyệt sẵn sàng (tại thời điểm chốt).</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {d.arrivalsNotReady.items.map((i, idx) => (
                    <tr key={`${i.unitCode}-${idx}`}>
                      <td className="strong">{i.unitCode}</td>
                      <td>
                        <Badge tone="warn">{READINESS_LABELS[i.readiness as ReadinessStatus] ?? i.readiness}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Kết nối kênh tại thời điểm chốt" pad={false}>
          {d.connectors.length === 0 ? (
            <EmptyState title="Chưa có kết nối nào được cấu hình" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {d.connectors.map((c) => (
                    <tr key={c.id}>
                      <td className="strong">
                        {c.label} {c.status === "demo" ? <DemoBadge /> : null}
                      </td>
                      <td>
                        <Badge tone={connectorTone(c.status)}>{CONNECTOR_STATUS_LABELS[c.status] ?? c.status}</Badge> {c.paused ? <Badge tone="warn">Tạm dừng</Badge> : null}{" "}
                        {c.stale ? <Badge tone="danger">Dữ liệu cũ</Badge> : null}
                      </td>
                      <td className="small">{c.lastSuccessAt ? formatInstant(c.lastSuccessAt, timezone) : <span className="faint">Chưa đồng bộ thành công</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Xem trước tin WhatsApp" actions={<CopyPreview text={preview} />}>
        <pre className="mono small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
          {preview}
        </pre>
        <div className="hint" style={{ marginTop: 8 }}>
          Chỉ là bản xem trước — chưa gửi cho ai. Gửi tự động cần: đăng ký nhận báo cáo được bật, công tắc “Gửi báo cáo” và “WhatsApp nội bộ” đang chạy, mẫu tin <span className="mono">daily_report</span> đã duyệt, và số người nhận từng nhắn vào tổng đài.
        </div>
      </Card>
    </>
  );
}
