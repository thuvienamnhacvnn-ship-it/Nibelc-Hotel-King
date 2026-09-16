import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, PageHeader, Pagination } from "@/components/ui";
import { pageParams } from "@/lib/http";
import { formatMoney } from "@/lib/money";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { BOOKING_SORTS, filtersToQuery, listBookings, parseBookingFilters, propertiesOf, unitOptions } from "@/modules/booking/queries";
import { BOOKING_STATUSES, BOOKING_STATUS_LABELS, CHANNEL_LABELS, PAYMENT_STATUS_LABELS, SOURCE_CHANNELS, STAY_STATUSES, STAY_STATUS_LABELS } from "@/modules/booking/types";
import { bookingTone, stayTone } from "./_components/tones";
import styles from "./bookings.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Booking" };

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireActor("booking.view");
  const sp = await searchParams;
  const filters = parseBookingFilters(sp);
  const pageQs = new URLSearchParams();
  for (const k of ["page", "pageSize"]) if (typeof sp[k] === "string") pageQs.set(k, sp[k]);
  const page = pageParams(new URL(`http://local/?${pageQs}`));
  const [data, units] = await Promise.all([listBookings(actor, filters, page), unitOptions(actor)]);
  const properties = propertiesOf(units);
  const showGuest = can(actor, "booking.view_guest_contact");
  const showMoney = can(actor, "revenue.view");
  const exportHref = `/api/v1/bookings/export?${filtersToQuery(filters)}`;
  const hasFilter = filtersToQuery({ ...filters, sort: "check_in_asc" }) !== "";

  return (
    <div className="stack">
      <PageHeader
        title="Booking"
        description="Bảng booking lấy từ cơ sở dữ liệu, tương ứng file Excel vận hành. Ngày lọc theo giờ Budapest: booking hiện ra khi có ít nhất một đêm nằm trong khoảng."
        actions={
          <>
            <a className="btn" href={exportHref}>
              Xuất Excel
            </a>
            {can(actor, "booking.create") ? (
              <Link className="btn btn-primary" href="/bookings/moi">
                Tạo booking
              </Link>
            ) : null}
          </>
        }
      />

      <Card>
        <form method="get" className={styles.filters}>
          <div className="field">
            <label htmlFor="f-from">Từ ngày</label>
            <input id="f-from" className="input" type="date" name="from" defaultValue={filters.from ?? ""} />
          </div>
          <div className="field">
            <label htmlFor="f-to">Đến ngày</label>
            <input id="f-to" className="input" type="date" name="to" defaultValue={filters.to ?? ""} />
          </div>
          <div className="field">
            <label htmlFor="f-property">Nhà</label>
            <select id="f-property" className="select" name="property" defaultValue={filters.propertyId ?? ""}>
              <option value="">Tất cả</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-unit">Căn/phòng</label>
            <select id="f-unit" className="select" name="unit" defaultValue={filters.unitId ?? ""}>
              <option value="">Tất cả</option>
              {properties.map((p) => (
                <optgroup key={p.id} label={p.code}>
                  {units
                    .filter((u) => u.property_id === p.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.code} — {u.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-channel">Kênh</label>
            <select id="f-channel" className="select" name="channel" defaultValue={filters.channel ?? ""}>
              <option value="">Tất cả</option>
              {SOURCE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-status">Trạng thái booking</label>
            <select id="f-status" className="select" name="status" defaultValue={filters.bookingStatus ?? ""}>
              <option value="">Tất cả</option>
              {BOOKING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {BOOKING_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-stay">Lưu trú</label>
            <select id="f-stay" className="select" name="stay" defaultValue={filters.stayStatus ?? ""}>
              <option value="">Tất cả</option>
              {STAY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STAY_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-q">{showGuest ? "Mã đặt phòng / tên khách" : "Mã đặt phòng"}</label>
            <input id="f-q" className="input" type="search" name="q" defaultValue={filters.q ?? ""} placeholder={showGuest ? "VD: HM1005 hoặc tên" : "VD: HM1005"} />
          </div>
          <div className="field">
            <label htmlFor="f-sort">Sắp xếp</label>
            <select id="f-sort" className="select" name="sort" defaultValue={filters.sort}>
              {Object.entries(BOOKING_SORTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.checks}>
            <label className="row small">
              <input type="checkbox" name="pending" value="1" defaultChecked={filters.pendingOnly} /> Chỉ booking có thay đổi chưa xử lý
            </label>
            <label className="row small">
              <input type="checkbox" name="conflict" value="1" defaultChecked={filters.conflictOnly} /> Chỉ booking có xung đột
            </label>
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary">
              Lọc
            </button>
            {hasFilter || filters.sort !== "check_in_asc" ? (
              <Link className="btn" href="/bookings">
                Bỏ lọc
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card pad={false}>
        {data.items.length === 0 ? (
          <EmptyState title={hasFilter ? "Không có booking khớp bộ lọc" : "Chưa có booking nào"}>
            {hasFilter ? "Thử mở rộng khoảng ngày hoặc bỏ bớt điều kiện lọc." : "Booking sẽ xuất hiện khi được tạo tay, nhập Excel hoặc nhận từ kênh."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className={`table ${styles.table}`}>
              <thead>
                <tr>
                  <th className="num">STT</th>
                  <th>Nhận booking</th>
                  {showGuest ? <th>Khách</th> : null}
                  <th>Kênh / ghi chú</th>
                  <th>Căn/phòng</th>
                  <th>Mã đặt phòng</th>
                  <th>Nhận → trả</th>
                  <th className="num">Đêm</th>
                  <th className="num">Khách</th>
                  <th>ETA</th>
                  <th>Trạng thái</th>
                  {showMoney ? <th className="num">Số tiền</th> : null}
                  <th>Cần xử lý</th>
                  <th>Đồng bộ gần nhất</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((b) => (
                  <tr key={b.id} className={b.booking_status === "cancelled" ? styles.cancelled : undefined}>
                    <td className="num faint">{b.stt}</td>
                    <td className="small">{b.booking_created_at ? formatInstant(b.booking_created_at, actor.timezone) : <span className="faint">—</span>}</td>
                    {showGuest ? (
                      <td>
                        <div>{b.guest_name ?? "—"}</div>
                        {b.guest_phone ? <div className="small faint">{b.guest_phone}</div> : null}
                      </td>
                    ) : null}
                    <td className={styles.notes}>
                      <div className="strong">
                        {CHANNEL_LABELS[b.source_channel] ?? b.source_channel}
                        {b.source_account ? <span className="faint small"> · {b.source_account}</span> : null}
                      </div>
                      {b.channel_note ? (
                        <div className="small">
                          <span className="faint">Kênh:</span> {b.channel_note}
                        </div>
                      ) : null}
                      {b.ops_note ? (
                        <div className="small">
                          <span className="faint">Vận hành:</span> {b.ops_note}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {b.allocations.length === 0 ? (
                        <span className="faint">—</span>
                      ) : (
                        b.allocations.map((a) => (
                          <div key={a.id} className={styles.alloc}>
                            <span className="strong">{a.unit_code}</span> <span className="faint small">{a.property_code}</span>
                            {a.start_date !== b.check_in_date || a.end_date !== b.check_out_date ? (
                              <span className="small faint">
                                {" "}
                                {formatDateVi(a.start_date).slice(0, 5)}→{formatDateVi(a.end_date).slice(0, 5)}
                              </span>
                            ) : null}
                            {a.status === "conflict" ? <Badge tone="danger">xung đột</Badge> : null}
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      <Link href={`/bookings/${b.id}`} className="strong">
                        {b.external_ref ?? "(không mã)"}
                      </Link>{" "}
                      <DemoBadge show={b.is_demo} />
                    </td>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>
                      {formatDateVi(b.check_in_date)}
                      <br />
                      {formatDateVi(b.check_out_date)}
                    </td>
                    <td className="num">{b.nights}</td>
                    <td className="num" title={b.adults != null || b.children != null ? `${b.adults ?? 0} người lớn, ${b.children ?? 0} trẻ em` : undefined}>
                      {b.total_guests ?? "—"}
                    </td>
                    <td className="small">{b.eta_local ?? <span className="faint">—</span>}</td>
                    <td>
                      <div className={styles.badges}>
                        <Badge tone={bookingTone(b.booking_status)}>{BOOKING_STATUS_LABELS[b.booking_status]}</Badge>
                        <Badge tone={stayTone(b.stay_status)}>{STAY_STATUS_LABELS[b.stay_status]}</Badge>
                        <Badge tone="neutral">{PAYMENT_STATUS_LABELS[b.payment_status]}</Badge>
                      </div>
                    </td>
                    {showMoney ? <td className="num">{formatMoney(b.total_amount_minor, b.currency)}</td> : null}
                    <td>
                      <div className={styles.badges}>
                        {b.pending_changes ? <Badge tone="warn">{b.pending_changes} thay đổi chờ</Badge> : null}
                        {b.open_conflicts ? <Badge tone="danger">{b.open_conflicts} xung đột</Badge> : null}
                        {!b.pending_changes && !b.open_conflicts ? <span className="faint">—</span> : null}
                      </div>
                    </td>
                    <td className="small">{b.last_synced_at ? formatInstant(b.last_synced_at, actor.timezone) : <span className="faint">Chưa đồng bộ kênh</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad">
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => `/bookings?${filtersToQuery(filters, { page: p })}`} />
        </div>
      </Card>
    </div>
  );
}
