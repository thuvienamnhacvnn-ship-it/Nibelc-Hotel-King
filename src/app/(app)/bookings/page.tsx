import Link from "next/link";
import { FilterPanel } from "@/components/client";
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
  const secondaryActive = [filters.propertyId, filters.unitId, filters.channel, filters.stayStatus, filters.pendingOnly || null, filters.conflictOnly || null, filters.sort !== "check_in_asc" || null].filter(Boolean).length;
  const activeFilters = [filters.from, filters.to, filters.propertyId, filters.unitId, filters.channel, filters.bookingStatus, filters.stayStatus, filters.q, filters.pendingOnly || null, filters.conflictOnly || null].filter(Boolean).length;

  return (
    <div className="stack">
      <PageHeader
        title="Booking"
        description={`${data.total} booking · lọc theo ngày ở (giờ Budapest)`}
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

      <Card pad={false}>
        <FilterPanel active={activeFilters}>
          <form method="get" className={styles.filterForm}>
            <div className={styles.filterMain}>
              <div className="field" style={{ flex: "2 1 240px" }}>
                <label htmlFor="f-q">Tìm kiếm</label>
                <input id="f-q" className="input" type="search" name="q" defaultValue={filters.q ?? ""} placeholder={showGuest ? "Mã đặt phòng hoặc tên khách" : "Mã đặt phòng"} />
              </div>
              <div className="field">
                <label htmlFor="f-from">Từ ngày</label>
                <input id="f-from" className="input" type="date" name="from" defaultValue={filters.from ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="f-to">Đến ngày</label>
                <input id="f-to" className="input" type="date" name="to" defaultValue={filters.to ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="f-status">Trạng thái</label>
                <select id="f-status" className="select" name="status" defaultValue={filters.bookingStatus ?? ""}>
                  <option value="">Tất cả</option>
                  {BOOKING_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {BOOKING_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.filterActions}>
                <button type="submit" className="btn btn-primary">
                  Lọc
                </button>
                {hasFilter || filters.sort !== "check_in_asc" ? (
                  <Link className="btn" href="/bookings">
                    Bỏ lọc
                  </Link>
                ) : null}
              </div>
            </div>
            <details className={styles.moreFilters} open={secondaryActive > 0 || undefined}>
              <summary>Thêm bộ lọc{secondaryActive ? ` (${secondaryActive})` : ""}</summary>
              <div className={styles.filterMain}>
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
                    <input type="checkbox" name="pending" value="1" defaultChecked={filters.pendingOnly} /> Có thay đổi chờ duyệt
                  </label>
                  <label className="row small">
                    <input type="checkbox" name="conflict" value="1" defaultChecked={filters.conflictOnly} /> Có xung đột
                  </label>
                </div>
              </div>
            </details>
          </form>
        </FilterPanel>
      </Card>

      <Card pad={false}>
        {data.items.length === 0 ? (
          <EmptyState title={hasFilter ? "Không có booking khớp bộ lọc" : "Chưa có booking nào"}>
            {hasFilter ? "Thử mở rộng khoảng ngày hoặc bỏ bớt điều kiện lọc." : "Booking sẽ xuất hiện khi được tạo tay, nhập Excel hoặc nhận từ kênh."}
          </EmptyState>
        ) : (
          <>
          <ul className={`show-mobile ${styles.mList}`}>
            {data.items.map((b) => (
              <MobileBookingCard key={b.id} b={b} showGuest={showGuest} showMoney={showMoney} tz={actor.timezone} />
            ))}
          </ul>
          <div className="table-wrap hide-mobile">
            <table className={`table ${styles.table}`} data-mobile="scroll">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Phòng</th>
                  {showGuest ? <th>Khách</th> : null}
                  <th>Lưu trú</th>
                  <th>Trạng thái</th>
                  {showMoney ? <th className="num">Số tiền</th> : null}
                  <th>Cần xử lý</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((b) => {
                  const conflict = b.open_conflicts > 0 || b.allocations.some((a) => a.status === "conflict");
                  return (
                    <tr key={b.id} className={b.booking_status === "cancelled" ? styles.cancelled : undefined}>
                      <td>
                        <Link href={`/bookings/${b.id}`} className="strong">
                          {b.external_ref ?? "(không mã)"}
                        </Link>{" "}
                        <DemoBadge show={b.is_demo} />
                        <div className="small faint">
                          {CHANNEL_LABELS[b.source_channel] ?? b.source_channel}
                          {b.source_account ? ` · ${b.source_account}` : ""}
                        </div>
                        {b.ops_note ? (
                          <div className={`small ${styles.note}`} title={b.ops_note}>
                            {b.ops_note}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {b.allocations.length === 0 ? (
                          <span className="faint">Chưa xếp</span>
                        ) : (
                          b.allocations.map((a) => (
                            <div key={a.id} className={styles.alloc}>
                              <span className="strong">{a.unit_code}</span>
                              {a.start_date !== b.check_in_date || a.end_date !== b.check_out_date ? (
                                <span className="small faint">
                                  {" "}
                                  {formatDateVi(a.start_date).slice(0, 5)}→{formatDateVi(a.end_date).slice(0, 5)}
                                </span>
                              ) : null}
                            </div>
                          ))
                        )}
                      </td>
                      {showGuest ? (
                        <td>
                          <div>{b.guest_name ?? "—"}</div>
                          <div className="small faint">{b.total_guests != null ? `${b.total_guests} khách` : ""}</div>
                        </td>
                      ) : null}
                      <td style={{ whiteSpace: "nowrap" }}>
                        <div>
                          {formatDateVi(b.check_in_date).slice(0, 5)} → {formatDateVi(b.check_out_date).slice(0, 5)}
                          <span className="faint small"> · {b.nights} đêm</span>
                        </div>
                        <div className="small faint">
                          {!showGuest && b.total_guests != null ? `${b.total_guests} khách` : ""}
                          {b.eta_local ? `${!showGuest && b.total_guests != null ? " · " : ""}ETA ${b.eta_local}` : ""}
                        </div>
                      </td>
                      <td>
                        {/* Booking đã xác nhận là mặc định — chỉ nêu trạng thái booking khi khác thường, còn lại nêu tình trạng lưu trú */}
                        {b.booking_status === "confirmed" ? (
                          <Badge tone={stayTone(b.stay_status)}>{STAY_STATUS_LABELS[b.stay_status]}</Badge>
                        ) : (
                          <Badge tone={bookingTone(b.booking_status)}>{BOOKING_STATUS_LABELS[b.booking_status]}</Badge>
                        )}
                        {b.payment_status !== "unknown" ? (
                          <div className="small faint" style={{ marginTop: 3 }}>
                            {PAYMENT_STATUS_LABELS[b.payment_status]}
                          </div>
                        ) : null}
                      </td>
                      {showMoney ? <td className="num">{b.total_amount_minor != null ? formatMoney(b.total_amount_minor, b.currency) : <span className="faint">—</span>}</td> : null}
                      <td>
                        {b.pending_changes || conflict ? (
                          <div className={styles.badges}>
                            {conflict ? <Badge tone="danger">Xung đột</Badge> : null}
                            {b.pending_changes ? <Badge tone="warn">{b.pending_changes} thay đổi chờ</Badge> : null}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
        <div className="card-pad">
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => `/bookings?${filtersToQuery(filters, { page: p })}`} />
        </div>
      </Card>
    </div>
  );
}

type BookingRow = Awaited<ReturnType<typeof listBookings>>["items"][number];

/** Thẻ booking trên điện thoại: phòng + trạng thái nổi bật, ngày ở dạng dòng thời gian, cả thẻ bấm được. */
function MobileBookingCard({ b, showGuest, showMoney, tz }: { b: BookingRow; showGuest: boolean; showMoney: boolean; tz: string }) {
  const units = b.allocations.map((a) => a.unit_code).join(" · ") || "Chưa xếp phòng";
  const conflict = b.open_conflicts > 0 || b.allocations.some((a) => a.status === "conflict");
  return (
    <li>
      <Link href={`/bookings/${b.id}`} className={`${styles.mCard} ${b.booking_status === "cancelled" ? styles.mCancelled : ""} ${conflict ? styles.mConflict : ""}`}>
        <div className={styles.mTop}>
          <div className={styles.mUnit}>{units}</div>
          {b.booking_status === "confirmed" ? <Badge tone={stayTone(b.stay_status)}>{STAY_STATUS_LABELS[b.stay_status]}</Badge> : <Badge tone={bookingTone(b.booking_status)}>{BOOKING_STATUS_LABELS[b.booking_status]}</Badge>}
        </div>
        {showGuest && b.guest_name ? <div className={styles.mGuest}>{b.guest_name}</div> : null}
        <div className={styles.mDates}>
          <div>
            <div className={styles.mDateLabel}>Nhận</div>
            <div className={styles.mDate}>{formatDateVi(b.check_in_date).slice(0, 5)}</div>
          </div>
          <div className={styles.mNights}>
            <span>{b.nights} đêm</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className={styles.mDateLabel}>Trả</div>
            <div className={styles.mDate}>{formatDateVi(b.check_out_date).slice(0, 5)}</div>
          </div>
        </div>
        <div className={styles.mMeta}>
          <span className="strong">{CHANNEL_LABELS[b.source_channel] ?? b.source_channel}</span>
          <span>{b.external_ref ?? "(không mã)"}</span>
          {b.total_guests != null ? <span>{b.total_guests} khách</span> : null}
          {b.eta_local ? <span>ETA {b.eta_local}</span> : null}
          {showMoney && b.total_amount_minor != null ? <span className="strong">{formatMoney(b.total_amount_minor, b.currency)}</span> : null}
        </div>
        {b.payment_status !== "unknown" || b.pending_changes || conflict || b.is_demo ? (
        <div className={`${styles.mBadges} ${b.payment_status === "unknown" && !b.pending_changes && !conflict ? styles.mBadgesDemoOnly : ""}`}>
          {b.payment_status !== "unknown" ? <Badge tone="neutral">{PAYMENT_STATUS_LABELS[b.payment_status]}</Badge> : null}
          {b.pending_changes ? <Badge tone="warn">{b.pending_changes} thay đổi chờ</Badge> : null}
          {conflict ? <Badge tone="danger">Xung đột</Badge> : null}
          <DemoBadge show={b.is_demo} />
        </div>
        ) : null}
        {b.ops_note ? <div className={styles.mNote}>{b.ops_note}</div> : null}
      </Link>
    </li>
  );
}
