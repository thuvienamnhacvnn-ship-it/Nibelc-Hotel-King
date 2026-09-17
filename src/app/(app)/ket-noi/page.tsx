import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, Notice, PageHeader, Pagination, type Tone, HelpNote, FoldCard } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { formatInstant } from "@/lib/time";
import { DEMO_SCENARIO_LABELS, canRunDemoFeed } from "@/modules/connectors/demo-feed";
import { CONNECTOR_STATUS_LABELS, connectorTone } from "@/modules/connectors/labels";
import { INBOUND_STATUSES, INBOUND_STATUS_LABELS, listConnectors, listInboundEvents } from "@/modules/connectors/queries";
import { canPauseConnector } from "@/modules/connectors/service";
import { DemoFeedPanel, PauseButton } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kết nối kênh" };

type SP = Promise<Record<string, string | string[] | undefined>>;

const CAPABILITY_LABELS: Record<string, string> = {
  bookings: "Booking",
  messages: "Tin nhắn",
  calendar_ical: "Lịch iCal",
  calling: "Gọi thoại",
};

const EVENT_TONES: Record<string, Tone> = {
  received: "info",
  applied: "ok",
  duplicate: "neutral",
  stale: "neutral",
  needs_reconcile: "warn",
  conflict: "danger",
  failed: "danger",
};

function formatLatency(ms: number | null) {
  if (ms == null) return null;
  if (ms < 1) return "< 1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} giây`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} phút ${Math.round((ms % 60_000) / 1000)} giây`;
  return `${Math.floor(m / 60)} giờ ${m % 60} phút`;
}

export default async function ConnectorsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("connector.view");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const rawPage = Number(str("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= 100_000 ? rawPage : 1;
  const connectorFilter = str("connector");
  const statusFilter = str("status");

  const [connectors, events] = await Promise.all([
    listConnectors(actor),
    listInboundEvents(actor, { connectorId: connectorFilter, status: statusFilter }, { page, pageSize: 25, offset: (page - 1) * 25 }),
  ]);
  const canPause = canPauseConnector(actor);
  const canDemo = canRunDemoFeed(actor);
  const demoConnectors = connectors.filter((c) => c.status === "demo");
  const liveCount = connectors.filter((c) => c.status === "active").length;

  const eventsHref = (p: number) => {
    const q = new URLSearchParams();
    if (connectorFilter) q.set("connector", connectorFilter);
    if (statusFilter) q.set("status", statusFilter);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return `/ket-noi${s ? `?${s}` : ""}#su-kien`;
  };

  return (
    <div className="stack">
      <PageHeader
        title="Kết nối kênh"
        description="Trạng thái các kênh bán và nhắn tin, sự kiện nhận gần đây."
        actions={
          <a className="btn" href="/ket-noi/ical">
            Đối chiếu lịch iCal
          </a>
        }
      />
      {liveCount === 0 ? (
        <Notice tone="warn" title="Chưa có kênh thật nào được kết nối">
          Booking hiện đến từ nhập tay, nhập Excel và nguồn DEMO. Lịch trên hệ thống không phản ánh Airbnb/Booking.com theo thời gian thực.
        </Notice>
      ) : null}

      <Card title={`Kênh kết nối (${connectors.length})`} pad={false}>
        {connectors.length === 0 ? (
          <EmptyState title="Chưa khai báo connector nào" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Kênh</th>
                  <th>Trạng thái</th>
                  <th>Dùng được</th>
                  <th>Đồng bộ gần nhất</th>
                  <th className="num">Sự kiện 24h</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((c) => {
                  const caps = Object.entries(c.capabilities ?? {}).filter(([, v]) => v);
                  return (
                    <tr key={c.id}>
                      <td title={c.note ?? undefined}>
                        <div className="strong">
                          {c.label} {c.status === "demo" ? <DemoBadge /> : null}
                        </div>
                      </td>
                      <td>
                        <Badge tone={connectorTone(c.status)} title={c.status === "not_configured" ? "Chưa có quyền truy cập API — cần chủ hệ thống cung cấp" : undefined}>
                          {c.status === "demo" ? "Giả lập" : CONNECTOR_STATUS_LABELS[c.status] ?? c.status}
                        </Badge>
                        {c.paused ? <Badge tone="warn">Tạm dừng</Badge> : null}
                      </td>
                      <td className="small">{caps.length ? caps.map(([k]) => CAPABILITY_LABELS[k] ?? k).join(" · ") : <span className="faint">—</span>}</td>
                      <td className="small">
                        {c.last_success_at ? formatInstant(c.last_success_at, actor.timezone) : <span className="faint">Chưa có</span>}
                        {c.last_error ? (
                          <div style={{ color: "var(--danger)" }} title={c.last_error}>
                            Lỗi gần nhất: {c.last_error.length > 60 ? `${c.last_error.slice(0, 60)}…` : c.last_error}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">
                        {c.events_24h || <span className="faint">0</span>}
                        {c.failed_24h ? <div className="small" style={{ color: "var(--danger)" }}>{c.failed_24h} lỗi</div> : null}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {canPause && c.status !== "not_configured" ? <PauseButton connector={{ id: c.id, label: c.label, paused: c.paused }} /> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {demoConnectors.length ? (
        <FoldCard title="Công cụ thử với nguồn DEMO" hint="giả lập booking trùng, sai thứ tự, xung đột">
          <div className="stack" style={{ padding: 12 }}>
            {demoConnectors.map((c) =>
            canDemo ? (
              <DemoFeedPanel key={c.id} connector={{ id: c.id, label: c.label, paused: c.paused }} scenarios={DEMO_SCENARIO_LABELS} />
            ) : (
              <Notice key={c.id} tone="demo" title={`Nguồn DEMO: ${c.label}`}>
                Nguồn giả lập để thử xử lý trùng/sai thứ tự/xung đột. Cần quyền quản lý kết nối hoặc duyệt thay đổi booking để chạy.
              </Notice>
            ),
          )}
          </div>
        </FoldCard>
      ) : null}

      <div id="su-kien" />
      <Card title={`Nhật ký sự kiện nhận (${events.total})`} pad={false}>
        <form method="get" action="/ket-noi#su-kien" className="row card-pad" style={{ paddingBottom: 8 }}>
          <label className="label" htmlFor="f-connector">
            Connector
          </label>
          <select id="f-connector" name="connector" className="select" style={{ width: "auto" }} defaultValue={connectorFilter ?? ""}>
            <option value="">Tất cả</option>
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <label className="label" htmlFor="f-status">
            Trạng thái
          </label>
          <select id="f-status" name="status" className="select" style={{ width: "auto" }} defaultValue={statusFilter ?? ""}>
            <option value="">Tất cả</option>
            {INBOUND_STATUSES.map((s) => (
              <option key={s} value={s}>
                {INBOUND_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-sm">
            Lọc
          </button>
          {connectorFilter || statusFilter ? (
            <Link href="/ket-noi#su-kien" className="btn btn-sm">
              Bỏ lọc
            </Link>
          ) : null}
        </form>
        {events.items.length === 0 ? (
          <EmptyState title="Chưa có sự kiện nào">{connectorFilter || statusFilter ? "Không có sự kiện khớp bộ lọc." : "Chưa connector nào gửi sự kiện."}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nhận lúc</th>
                  <th>Nguồn phát sinh</th>
                  <th className="num">Nguồn → nhận</th>
                  <th className="num">Nhận → xử lý xong</th>
                  <th>Connector</th>
                  <th>Sự kiện</th>
                  <th>Trạng thái</th>
                  <th>Booking</th>
                </tr>
              </thead>
              <tbody>
                {events.items.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{formatInstant(e.received_at, actor.timezone)}</td>
                    <td className="small">{e.source_occurred_at ? formatInstant(e.source_occurred_at, actor.timezone) : <span className="faint">Nguồn không gửi</span>}</td>
                    <td className="num small">{formatLatency(e.source_to_received_ms) ?? <span className="faint">—</span>}</td>
                    <td className="num small">
                      {e.same_instant ? (
                        <span className="faint" title="Hai mốc đang được ghi trong cùng một giao dịch nên chưa đo được — xem ghi chú dưới bảng">
                          chưa đo được*
                        </span>
                      ) : (
                        formatLatency(e.received_to_processed_ms) ?? <span className="faint">chưa xử lý</span>
                      )}
                    </td>
                    <td className="small">
                      {e.connector_label} {e.connector_status === "demo" ? <DemoBadge /> : null}
                    </td>
                    <td className="small">
                      <div>
                        {e.event_type === "booking.cancelled" ? "Hủy" : "Tạo/cập nhật"} · {e.external_ref ?? "—"}
                        {e.source_version != null ? ` · v${e.source_version}` : ""}
                      </div>
                      <div className="mono faint" style={{ fontSize: 11 }}>
                        {e.external_event_id}
                      </div>
                    </td>
                    <td>
                      <Badge tone={EVENT_TONES[e.status] ?? "neutral"}>{INBOUND_STATUS_LABELS[e.status] ?? e.status}</Badge>
                      {e.message ? <div className="small muted">{e.message}</div> : null}
                    </td>
                    <td className="small">{e.booking_id ? <Link href={`/bookings/${e.booking_id}`}>{e.booking_ref ?? "Mở booking"}</Link> : <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad stack" style={{ gap: 6 }}>
          {events.items.some((e) => e.same_instant) ? (
            <div className="small muted">
              * Sự kiện nhận trước bản sửa lõi 16/09 ghi “nhận lúc” và “xử lý xong” cùng một mốc nên không đo được độ trễ nhận → xử lý. Sự kiện mới đo bình thường.
            </div>
          ) : null}
          <Pagination page={events.page} pageSize={events.pageSize} total={events.total} hrefFor={eventsHref} />
        </div>
      </Card>
    </div>
  );
}
