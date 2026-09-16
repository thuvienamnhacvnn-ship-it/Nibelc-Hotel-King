import Link from "next/link";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { query } from "@/lib/db";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANNEL_LABELS } from "@/modules/booking/types";
import { listFeeds, listFindings } from "@/modules/icalsync/service";
import { AddFeedForm, FeedActions, FindingActions } from "./ical-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đối chiếu lịch iCal" };

const KIND_LABELS: Record<string, { label: string; tone: "danger" | "warn"; hint: string }> = {
  channel_busy_not_in_system: { label: "Kênh bận — hệ thống trống", tone: "danger", hint: "Có thể có booking trên kênh chưa được nhập vào hệ thống." },
  system_busy_channel_free: { label: "Hệ thống có khách — kênh còn trống", tone: "warn", hint: "Kênh chưa đóng bán những đêm này — nguy cơ bán trùng." },
};

export default async function IcalPage() {
  const actor = await requireActor("connector.view");
  const [feeds, findings] = await Promise.all([listFeeds(actor), listFindings(actor, "open")]);
  const listings = can(actor, "connector.manage")
    ? await query<{ id: string; channel: string; listing_name: string | null; unit_code: string }>(
        `SELECT l.id, l.channel, l.listing_name, u.code AS unit_code FROM channel_listings l JOIN units u ON u.id = l.unit_id
          WHERE l.org_id = $1 AND l.channel IN ('airbnb','booking_com') AND NOT EXISTS (SELECT 1 FROM ical_feeds f WHERE f.listing_id = l.id)
          ORDER BY u.code, l.channel`,
        [actor.orgId],
      )
    : [];

  return (
    <div className="stack">
      <PageHeader
        title="Đối chiếu lịch iCal"
        description="Kết nối CHỈ ĐỌC: tải lịch bận/trống từ Airbnb, Booking.com và so với tồn phòng trong hệ thống. Không tạo hay sửa booking từ iCal."
        actions={
          <Link className="btn" href="/ket-noi">
            ← Kết nối kênh
          </Link>
        }
      />
      <Notice tone="info" title="Giới hạn của iCal">
        iCal chỉ có ngày bận/trống — không có tên khách, số khách, tin nhắn hay giá. Airbnb làm mới lịch nhập khoảng 3 giờ/lần, nên lệch trong vài giờ đầu là bình thường; booking mới tạo trong 4 giờ chưa bị báo &quot;kênh còn trống&quot;.
      </Notice>

      <Card title={`Lệch lịch đang mở (${findings.length})`} pad={false}>
        {findings.length === 0 ? (
          <EmptyState title="Không có lệch lịch đang mở">{feeds.length ? "Các link đã đồng bộ không thấy khác biệt." : "Chưa có link iCal nào."}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Phòng</th>
                  <th>Kênh</th>
                  <th>Loại lệch</th>
                  <th>Đêm</th>
                  <th>Thấy lần đầu</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => {
                  const k = KIND_LABELS[f.kind as string];
                  return (
                    <tr key={f.id as string}>
                      <td className="strong">{f.unit_code as string}</td>
                      <td>{CHANNEL_LABELS[f.channel as string]}</td>
                      <td>
                        <Badge tone={k.tone}>{k.label}</Badge>
                        <div className="small muted">{k.hint}</div>
                      </td>
                      <td>
                        {formatDateVi(f.start_date as string)} → {formatDateVi(f.end_date as string)}
                        <div className="small">
                          <Link href={`/lich?date=${f.start_date as string}`}>Mở lịch</Link>
                        </div>
                      </td>
                      <td className="small">{formatInstant(f.first_seen_at as Date, actor.timezone)}</td>
                      <td>{can(actor, "conflict.resolve") ? <FindingActions id={f.id as string} /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Link iCal (${feeds.length})`} pad={false}>
        {feeds.length === 0 ? (
          <EmptyState title="Chưa có link iCal">Trong extranet của kênh, mở phần đồng bộ lịch → xuất lịch, copy link .ics của từng phòng rồi thêm ở dưới.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Phòng</th>
                  <th>Kênh</th>
                  <th>Link (đã che)</th>
                  <th>Đồng bộ thành công gần nhất</th>
                  <th>Lỗi gần nhất</th>
                  <th className="num">Lệch mở</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {feeds.map((f) => (
                  <tr key={f.id as string}>
                    <td className="strong">{f.unit_code as string}</td>
                    <td>{CHANNEL_LABELS[f.channel as string]}</td>
                    <td className="mono small">{f.url_hint as string}</td>
                    <td className="small">{f.last_success_at ? formatInstant(f.last_success_at as Date, actor.timezone) : <Badge tone="warn">Chưa đồng bộ được</Badge>}</td>
                    <td className="small">{(f.last_error as string) ?? "—"}</td>
                    <td className="num">{f.open_findings as number}</td>
                    <td>
                      <FeedActions id={f.id as string} canManage={can(actor, "connector.manage")} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {can(actor, "connector.manage") ? (
          <div className="card-pad">
            <AddFeedForm listings={listings} />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
