import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, DemoBadge, EmptyState, KeyValue, Notice, PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANGE_REQUEST_STATUS_LABELS, CHANGE_SOURCE_LABELS, getBookingDetail, unitOptions } from "@/modules/booking/queries";
import { STAY_RULES } from "@/modules/booking/rules";
import { BOOKING_STATUS_LABELS, CHANGE_KIND_LABELS, CHANNEL_LABELS, PAYMENT_STATUS_LABELS, STAY_STATUS_LABELS } from "@/modules/booking/types";
import { TASK_KIND_LABELS, TASK_STATUS_LABELS } from "@/modules/cleaning/service";
import { ChangeRequestDecision, ResolveConflictButton } from "../_components/actions";
import { CheckResult } from "../_components/check-result";
import { bookingTone, changeRequestTone, stayTone } from "../_components/tones";
import styles from "../bookings.module.css";
import { CreateChangeRequestForm, EditDetailsForm, StayStatusButtons } from "./booking-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chi tiết booking" };

const ALLOCATION_STATUS: Record<string, { label: string; tone: "ok" | "neutral" | "danger" }> = {
  active: { label: "Đang giữ", tone: "ok" },
  released: { label: "Đã giải phóng", tone: "neutral" },
  conflict: { label: "Xung đột", tone: "danger" },
};

const FIELD_LABELS: Record<string, string> = {
  booking_status: "Trạng thái booking",
  stay_status: "Lưu trú",
  payment_status: "Thanh toán",
  check_in_date: "Ngày nhận",
  check_out_date: "Ngày trả",
  adults: "Người lớn",
  children: "Trẻ em",
  total_guests: "Tổng khách",
  eta_local: "ETA",
  early_checkin_time: "Nhận sớm",
  late_checkout_time: "Trả muộn",
  total_amount_minor: "Số tiền (cent)",
  currency: "Tiền tệ",
  channel_note: "Ghi chú kênh",
  ops_note: "Ghi chú vận hành",
  external_ref: "Mã đặt phòng",
  guest_name: "Tên khách",
  allocations: "Phân bổ phòng",
};

function fmtValue(key: string, v: unknown): string {
  if (v == null || v === "") return "—";
  if (key === "allocations" && Array.isArray(v)) {
    return v.length ? v.map((a: { unit: string; start: string; end: string; status: string }) => `${a.unit} ${a.start}→${a.end}${a.status === "conflict" ? " (xung đột)" : ""}`).join("; ") : "(không phòng)";
  }
  if (key === "booking_status") return BOOKING_STATUS_LABELS[String(v)] ?? String(v);
  if (key === "stay_status") return STAY_STATUS_LABELS[String(v)] ?? String(v);
  if (key === "payment_status") return PAYMENT_STATUS_LABELS[String(v)] ?? String(v);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null))
    .map((k) => ({ key: k, label: FIELD_LABELS[k] ?? k, before: before ? fmtValue(k, before[k]) : null, after: fmtValue(k, after?.[k]) }));
}

function changeTypeLabel(t: string) {
  if (t === "created") return "Tạo booking";
  if (t === "details_updated") return "Sửa thông tin";
  if (t.startsWith("change_request:")) return `Áp dụng yêu cầu: ${CHANGE_KIND_LABELS[t.slice(15)] ?? t.slice(15)}`;
  if (t.startsWith("stay:")) return `Lưu trú: ${STAY_STATUS_LABELS[t.slice(5)] ?? t.slice(5)}`;
  return t;
}

export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("booking.view");
  const { id } = await params;
  let data;
  try {
    data = await getBookingDetail(actor, id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const { booking: b, changes, changeRequests, conflicts, tasks, audit } = data;
  const showGuest = can(actor, "booking.view_guest_contact");
  const showMoney = can(actor, "revenue.view");
  const canApprove = can(actor, "booking.approve_change");
  const cancelled = b.booking_status === "cancelled";
  const activeAllocations = b.allocations.filter((a) => a.status !== "released");
  const units = can(actor, "booking.request_change") ? await unitOptions(actor) : [];
  const pendingRequests = changeRequests.filter((r) => r.status === "pending");
  const openConflicts = conflicts.filter((c) => c.status === "open");

  return (
    <div className="stack">
      <PageHeader
        title={
          <span className="row">
            Booking {b.external_ref ?? "(không mã)"} <DemoBadge show={b.is_demo} />
          </span>
        }
        description={`${CHANNEL_LABELS[b.source_channel] ?? b.source_channel}${b.source_account ? ` · ${b.source_account}` : ""} · phiên bản ${b.version}`}
        actions={
          <>
            <Link className="btn" href="/bookings">
              ← Danh sách
            </Link>
            {can(actor, "booking.edit") ? (
              <EditDetailsForm
                booking={{
                  id: b.id,
                  version: b.version,
                  eta_local: b.eta_local,
                  channel_note: b.channel_note,
                  ops_note: b.ops_note,
                  external_ref: b.external_ref,
                  payment_status: b.payment_status,
                  total_amount_minor: b.total_amount_minor,
                  currency: b.currency,
                  guest_name: b.guest_name,
                  guest_phone: b.guest_phone,
                  guest_email: b.guest_email,
                  guest_language: b.guest_language,
                }}
                showGuest={showGuest}
                showMoney={showMoney}
              />
            ) : null}
            {can(actor, "booking.request_change") && !cancelled ? (
              <CreateChangeRequestForm
                bookingId={b.id}
                checkInDate={b.check_in_date}
                checkOutDate={b.check_out_date}
                stayStatus={b.stay_status}
                adults={b.adults}
                children={b.children}
                allocations={activeAllocations.map((a) => ({ id: a.id, unit_id: a.unit_id, unit_code: a.unit_code, start_date: a.start_date, end_date: a.end_date, guests: a.guests }))}
                units={units.map((u) => ({ id: u.id, code: u.code, name: u.name, capacity: u.capacity, kind: u.kind, active: u.active, property_code: u.property_code }))}
                minCapacity={data.minCapacity}
                propertyTimes={data.propertyTimes}
                rules={STAY_RULES}
                canApprove={canApprove}
              />
            ) : null}
          </>
        }
      />

      {openConflicts.length ? (
        <Notice tone="danger" title={`${openConflicts.length} xung đột tồn đang mở`}>
          Booking này trùng đêm với booking/chặn tồn khác trên cùng phòng. Hệ thống không tự hủy booking của khách — cần người xử lý (đổi phòng qua yêu cầu thay đổi hoặc liên hệ kênh).
        </Notice>
      ) : null}
      {pendingRequests.length ? (
        <Notice tone="warn" title={`${pendingRequests.length} yêu cầu thay đổi đang chờ`}>
          Booking chưa đổi cho tới khi yêu cầu được áp dụng.
        </Notice>
      ) : null}

      <div className="grid grid-2">
        <Card title="Thông tin">
          <KeyValue
            items={[
              ["Trạng thái", <span key="s" className="row"><Badge tone={bookingTone(b.booking_status)}>{BOOKING_STATUS_LABELS[b.booking_status]}</Badge><Badge tone={stayTone(b.stay_status)}>{STAY_STATUS_LABELS[b.stay_status]}</Badge><Badge tone="neutral">{PAYMENT_STATUS_LABELS[b.payment_status]}</Badge></span>],
              ...(showGuest
                ? ([
                    ["Khách", b.guest_name],
                    ["SĐT", b.guest_phone],
                    ["Email", b.guest_email],
                    ["Ngôn ngữ", b.guest_language],
                  ] as [string, string | null][])
                : []),
              ["Nhận → trả", `${formatDateVi(b.check_in_date)} → ${formatDateVi(b.check_out_date)} (${b.nights} đêm)`],
              ["Khách", b.total_guests != null ? `${b.total_guests} (${b.adults ?? "?"} người lớn, ${b.children ?? "?"} trẻ em)` : null],
              ["ETA", b.eta_local],
              ["Nhận sớm / trả muộn", b.early_checkin_time || b.late_checkout_time ? `${b.early_checkin_time ? `nhận ${b.early_checkin_time.slice(0, 5)}` : ""}${b.early_checkin_time && b.late_checkout_time ? " · " : ""}${b.late_checkout_time ? `trả ${b.late_checkout_time.slice(0, 5)}` : ""}` : null],
              ["Nhận/trả thực tế", b.actual_check_in_at || b.actual_check_out_at ? `${b.actual_check_in_at ? `nhận ${formatInstant(b.actual_check_in_at, actor.timezone)}` : ""}${b.actual_check_out_at ? ` · trả ${formatInstant(b.actual_check_out_at, actor.timezone)}` : ""}` : null],
              ...(showMoney ? ([["Số tiền", formatMoney(b.total_amount_minor, b.currency)]] as [string, string][]) : []),
              ["Ghi chú kênh", b.channel_note],
              ["Ghi chú vận hành", b.ops_note ? <span key="o" style={{ whiteSpace: "pre-wrap" }}>{b.ops_note}</span> : null],
              ["Nhận booking lúc", b.booking_created_at ? formatInstant(b.booking_created_at, actor.timezone) : null],
              ["Tạo trên hệ thống", `${formatInstant(b.created_at, actor.timezone)}${b.created_by_name ? ` · ${b.created_by_name}` : ""}`],
              ["Nguồn cập nhật lúc", b.source_updated_at ? formatInstant(b.source_updated_at, actor.timezone) : null],
              ["Đồng bộ kênh gần nhất", b.last_synced_at ? formatInstant(b.last_synced_at, actor.timezone) : "Chưa đồng bộ từ kênh (nhập tay/Excel/DEMO)"],
            ]}
          />
        </Card>

        <div className="stack">
          <Card title="Thực tế lưu trú">
            {cancelled ? (
              <span className="small muted">Booking đã hủy — không đổi trạng thái lưu trú.</span>
            ) : can(actor, "booking.stay_status") ? (
              <StayStatusButtons bookingId={b.id} version={b.version} stayStatus={b.stay_status} />
            ) : (
              <span className="small muted">Bạn chỉ có quyền xem.</span>
            )}
          </Card>

          <Card title="Xung đột tồn" pad={false}>
            {conflicts.length === 0 ? (
              <EmptyState title="Không có xung đột" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Phòng</th>
                      <th>Khoảng</th>
                      <th>Trùng với</th>
                      <th>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conflicts.map((c) => (
                      <tr key={c.id}>
                        <td className="strong">{c.unit_code}</td>
                        <td className="small">
                          {formatDateVi(c.start_date)} → {formatDateVi(c.end_date)}
                        </td>
                        <td className="small">
                          {c.others.length
                            ? c.others.map((o, i) => (
                                <div key={i}>
                                  {o.block_reason ? `Chặn tồn: ${o.block_reason}` : o.booking_id ? <Link href={`/bookings/${o.booking_id}`}>{o.booking_ref ?? "(không mã)"}</Link> : "—"} {o.unit_code ? `· ${o.unit_code}` : ""}
                                </div>
                              ))
                            : "—"}
                        </td>
                        <td>
                          {c.status === "open" ? (
                            <div className="stack" style={{ gap: 4 }}>
                              <Badge tone="danger">Đang mở</Badge>
                              {can(actor, "conflict.resolve") ? <ResolveConflictButton id={c.id} summary={`${c.unit_code} · ${formatDateVi(c.start_date)} → ${formatDateVi(c.end_date)}`} /> : null}
                            </div>
                          ) : (
                            <div className="small">
                              <Badge tone="ok">Đã xử lý</Badge>
                              <div className="faint">
                                {c.resolution} {c.resolved_by_name ? `· ${c.resolved_by_name}` : ""} {c.resolved_at ? `· ${formatInstant(c.resolved_at, actor.timezone)}` : ""}
                              </div>
                            </div>
                          )}
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

      <Card title="Phân bổ phòng theo thời gian" pad={false}>
        {b.allocations.length === 0 ? (
          <EmptyState title="Chưa có phân bổ phòng" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Căn/phòng</th>
                  <th>Nhà</th>
                  <th>Loại</th>
                  <th>Từ → đến</th>
                  <th className="num">Khách</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {b.allocations.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className="strong">{a.unit_code}</span> <span className="small faint">{a.unit_name}</span>
                    </td>
                    <td>{a.property_code}</td>
                    <td className="small">{a.unit_kind === "whole" ? "Nguyên căn" : a.unit_kind === "studio" ? "Studio" : "Phòng lẻ"}</td>
                    <td className="small">
                      {formatDateVi(a.start_date)} → {formatDateVi(a.end_date)}
                    </td>
                    <td className="num">{a.guests ?? "—"}</td>
                    <td>
                      <Badge tone={ALLOCATION_STATUS[a.status]?.tone ?? "neutral"}>{ALLOCATION_STATUS[a.status]?.label ?? a.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Yêu cầu thay đổi (${changeRequests.length})`} pad={false}>
        {changeRequests.length === 0 ? (
          <EmptyState title="Chưa có yêu cầu thay đổi" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Loại / nội dung</th>
                  <th>Nguồn</th>
                  <th>Kiểm tra gần nhất</th>
                  <th>Trạng thái</th>
                  <th>Người duyệt</th>
                </tr>
              </thead>
              <tbody>
                {changeRequests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="strong">{CHANGE_KIND_LABELS[r.kind] ?? r.kind}</div>
                      <div className="small">{r.description}</div>
                      {r.note ? <div className="small faint">Ghi chú: {r.note}</div> : null}
                      <div className="small faint">Tạo từ phiên bản {r.booking_version}</div>
                    </td>
                    <td className="small">
                      {CHANGE_SOURCE_LABELS[r.source] ?? r.source}
                      {r.requested_by_name ? <div className="faint">{r.requested_by_name}</div> : null}
                      <div className="faint">{formatInstant(r.created_at, actor.timezone)}</div>
                    </td>
                    <td className="small">
                      <CheckResult check={r.check_result} timezone={actor.timezone} />
                    </td>
                    <td>
                      <Badge tone={changeRequestTone(r.status)}>{CHANGE_REQUEST_STATUS_LABELS[r.status] ?? r.status}</Badge>
                      {r.status === "pending" && r.booking_version !== b.version ? <div className="small faint">Booking đã sang phiên bản {b.version}</div> : null}
                    </td>
                    <td className="small">
                      {r.status === "pending" ? (
                        canApprove ? (
                          <ChangeRequestDecision id={r.id} summary={`${CHANGE_KIND_LABELS[r.kind]}: ${r.description}`} />
                        ) : (
                          <span className="faint">Chờ người có quyền duyệt</span>
                        )
                      ) : (
                        <>
                          {r.decided_by_name ?? "—"}
                          {r.decided_at ? <div className="faint">{formatInstant(r.decided_at, actor.timezone)}</div> : null}
                          {r.decision_note ? <div className="faint">{r.decision_note}</div> : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Lịch sử thay đổi (${changes.length})`} pad={false}>
        {changes.length === 0 ? (
          <EmptyState title="Chưa có lịch sử" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Phiên bản</th>
                  <th>Loại</th>
                  <th>Ai / nguồn</th>
                  <th>Trước → sau</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => {
                  const diff = diffFields(c.before, c.after);
                  return (
                    <tr key={c.id}>
                      <td className="num strong">v{c.version}</td>
                      <td className="small">
                        <div className="strong">{changeTypeLabel(c.change_type)}</div>
                        <div className="faint">{formatInstant(c.created_at, actor.timezone)}</div>
                        {c.reason ? <div className="faint">Ghi chú: {c.reason}</div> : null}
                      </td>
                      <td className="small">
                        {c.actor_name ?? c.actor_type}
                        {c.source ? <div className="faint">{c.source}</div> : null}
                      </td>
                      <td>
                        {c.before === null ? (
                          <span className="small muted">Bản ghi đầu tiên</span>
                        ) : diff.length === 0 ? (
                          <span className="small faint">Không có trường hiển thị nào thay đổi</span>
                        ) : (
                          <div className={styles.diff}>
                            {diff.map((d) => (
                              <div key={d.key} style={{ display: "contents" }}>
                                <span className="faint">{d.label}</span>
                                <span className={styles.before}>{d.before}</span>
                                <span className={styles.after}>{d.after}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {tasks ? (
        <Card title={`Việc dọn liên quan (${tasks.length})`} pad={false}>
          {tasks.length === 0 ? (
            <EmptyState title="Chưa có việc dọn gắn với booking này" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Phòng</th>
                    <th>Loại</th>
                    <th>Ngày</th>
                    <th>Hạn</th>
                    <th>Người làm</th>
                    <th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id}>
                      <td className="strong">
                        <Link href={`/cleaning/${t.id}`}>{t.unit_code}</Link>
                      </td>
                      <td className="small">
                        {TASK_KIND_LABELS[t.kind] ?? t.kind}
                        <div className="faint">{t.role === "departing" ? "khách này trả phòng" : "chuẩn bị cho khách này"}</div>
                      </td>
                      <td className="small">{formatDateVi(t.service_date)}</td>
                      <td className="small">{formatInstant(t.due_at, actor.timezone)}</td>
                      <td className="small">{t.assignee ?? <span className="faint">Chưa giao</span>}</td>
                      <td>
                        <Badge tone={t.status === "passed" ? "ok" : t.status === "cancelled" ? "neutral" : "info"}>{TASK_STATUS_LABELS[t.status] ?? t.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {audit ? (
        <Card title="Nhật ký thao tác" pad={false}>
          {audit.length === 0 ? (
            <EmptyState title="Chưa có nhật ký" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Thời điểm</th>
                    <th>Thao tác</th>
                    <th>Người</th>
                    <th>Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td className="small">{formatInstant(a.created_at, actor.timezone)}</td>
                      <td className="mono small">{a.action}</td>
                      <td className="small">{a.actor_name ?? a.actor_type}</td>
                      <td className="mono small" style={{ wordBreak: "break-word" }}>
                        {a.detail ? JSON.stringify(a.detail) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
