import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, Notice, PageHeader } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANGE_SOURCE_LABELS, listChangeRequests, listConflicts } from "@/modules/booking/queries";
import { CHANGE_KIND_LABELS, CHANNEL_LABELS } from "@/modules/booking/types";
import { ChangeRequestDecision, ResolveConflictButton } from "../bookings/_components/actions";
import { CheckResult } from "../bookings/_components/check-result";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chờ duyệt & xung đột" };

export default async function ApprovalQueuePage() {
  const actor = await requireActor("booking.view");
  const [requests, conflicts] = await Promise.all([listChangeRequests(actor, { status: "pending" }), listConflicts(actor, { status: "open" })]);
  const canApprove = can(actor, "booking.approve_change");
  const canResolve = can(actor, "conflict.resolve");
  const showGuest = can(actor, "booking.view_guest_contact");

  return (
    <div className="stack">
      <PageHeader
        title="Chờ duyệt & xung đột"
        description="Yêu cầu đổi ngày/phòng/số khách/hủy chỉ thay đổi booking khi người có quyền áp dụng. Xung đột tồn cần người xử lý."
      />
      <Notice tone="info" title="Hệ thống không tự hủy booking của khách">
        Khi hai nguồn cùng bán một đêm, cả hai booking được giữ lại và đánh dấu xung đột. Người vận hành quyết định cách xử lý (đổi phòng bằng yêu cầu thay đổi, liên hệ kênh) rồi ghi nhận ở đây.
      </Notice>
      {!canApprove && !canResolve ? <Notice tone="warn">Bạn chỉ có quyền xem hàng chờ này.</Notice> : null}

      <Card title={`Xung đột tồn đang mở (${conflicts.length})`} pad={false}>
        {conflicts.length === 0 ? (
          <EmptyState title="Không có xung đột đang mở" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Booking bị xung đột</th>
                  <th>Trùng với</th>
                  <th>Phòng</th>
                  <th>Khoảng ngày</th>
                  <th>Phát hiện</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link className="strong" href={`/bookings/${c.booking_id}`}>
                        {c.booking_ref ?? "(không mã)"}
                      </Link>{" "}
                      <DemoBadge show={c.booking_is_demo} />
                      <div className="small faint">
                        {CHANNEL_LABELS[c.source_channel] ?? c.source_channel}
                        {showGuest && c.guest_name ? ` · ${c.guest_name}` : ""}
                      </div>
                    </td>
                    <td className="small">
                      {c.others.length
                        ? c.others.map((o, i) => (
                            <div key={i}>
                              {o.block_reason ? (
                                `Chặn tồn: ${o.block_reason}`
                              ) : o.booking_id ? (
                                <Link href={`/bookings/${o.booking_id}`}>{o.booking_ref ?? "(không mã)"}</Link>
                              ) : (
                                "—"
                              )}{" "}
                              <span className="faint">
                                {o.source_channel ? CHANNEL_LABELS[o.source_channel] : ""} {o.unit_code ?? ""} {o.start_date}→{o.end_date}
                              </span>
                            </div>
                          ))
                        : "—"}
                    </td>
                    <td>
                      <span className="strong">{c.unit_code}</span> <span className="faint small">{c.property_code}</span>
                    </td>
                    <td className="small">
                      {formatDateVi(c.start_date)} → {formatDateVi(c.end_date)}
                    </td>
                    <td className="small">{formatInstant(c.created_at, actor.timezone)}</td>
                    <td>{canResolve ? <ResolveConflictButton id={c.id} summary={`${c.booking_ref ?? "(không mã)"} · ${c.unit_code} · ${formatDateVi(c.start_date)} → ${formatDateVi(c.end_date)}`} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Yêu cầu thay đổi chờ duyệt (${requests.length})`} pad={false}>
        {requests.length === 0 ? (
          <EmptyState title="Không có yêu cầu nào đang chờ" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Loại / nội dung</th>
                  <th>Nguồn</th>
                  <th>Kiểm tra lần cuối</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="strong" href={`/bookings/${r.booking_id}`}>
                        {r.booking_ref ?? "(không mã)"}
                      </Link>{" "}
                      <DemoBadge show={r.booking_is_demo} />
                      <div className="small faint">
                        {CHANNEL_LABELS[r.source_channel] ?? r.source_channel} · {formatDateVi(r.check_in_date)} → {formatDateVi(r.check_out_date)}
                      </div>
                      {showGuest && r.guest_name ? <div className="small faint">{r.guest_name}</div> : null}
                    </td>
                    <td>
                      <div className="strong">{CHANGE_KIND_LABELS[r.kind] ?? r.kind}</div>
                      <div className="small">{r.description}</div>
                      {r.note ? <div className="small faint">Ghi chú: {r.note}</div> : null}
                      {r.booking_version !== r.current_version ? (
                        <Badge tone="warn" title="Áp dụng sẽ chuyển yêu cầu sang hết hiệu lực">
                          Booking đã đổi (v{r.booking_version} → v{r.current_version})
                        </Badge>
                      ) : null}
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
                      {canApprove ? (
                        <ChangeRequestDecision id={r.id} summary={`${r.booking_ref ?? "(không mã)"} — ${CHANGE_KIND_LABELS[r.kind]}: ${r.description}`} />
                      ) : (
                        <span className="small faint">Chờ người có quyền duyệt</span>
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
  );
}
