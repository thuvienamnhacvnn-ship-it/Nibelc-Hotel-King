import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, Notice, PageHeader, Pagination, type Tone } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CONNECTOR_STATUS_LABELS, connectorTone } from "@/modules/connectors/labels";
import {
  HANDOFF_STATUS_LABELS,
  INBOX_CHANNEL_LABELS,
  KIND_LABELS,
  MESSAGE_STATUS_LABELS,
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_LABELS,
  VERIFICATION_LABELS,
  assignableUsers,
  senderHeartbeat,
  getConversationDetail,
  inboxSwitches,
  listConversations,
  listMessagingConnectors,
  parseInboxFilters,
} from "@/modules/inbox/queries";
import { canManageInbox, handoffReasonLabel } from "@/modules/inbox/service";
import { sendFailureLabel } from "@/modules/inbox/transport";
import { AttachBooking, CreateTicket, DraftActions, HandoffButtons, MarkRead, ReplyBox, RequestHandoff, RetryButton, TakeoverButtons, TicketActions } from "./actions";
import styles from "./hop-thu.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hộp thư & tổng đài" };

type SP = Promise<Record<string, string | string[] | undefined>>;

const MESSAGE_TONES: Record<string, Tone> = {
  received: "neutral",
  draft: "warn",
  pending_approval: "warn",
  queued: "info",
  sending: "info",
  sent: "info",
  delivered: "ok",
  read: "ok",
  failed: "danger",
  discarded: "neutral",
};

const PRIORITY_TONES: Record<string, Tone> = { P0: "danger", P1: "danger", P2: "warn" };

export default async function InboxPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("inbox.view");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const filters = parseInboxFilters(str);
  const rawPage = Number(str("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= 100_000 ? rawPage : 1;
  const selectedId = str("c");

  const [list, connectors, switches, detail, users, worker] = await Promise.all([
    listConversations(actor, filters, { page, pageSize: 40, offset: (page - 1) * 40 }),
    listMessagingConnectors(actor),
    inboxSwitches(actor),
    selectedId ? getConversationDetail(actor, selectedId) : Promise.resolve(null),
    assignableUsers(actor),
    senderHeartbeat(actor),
  ]);
  const perms = canManageInbox(actor);

  const href = (over: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const base: Record<string, string | null> = {
      kind: filters.kind,
      unread: filters.unread ? "1" : null,
      waiting: filters.waiting ? "1" : null,
      channel: filters.channel,
      c: selectedId,
      page: page > 1 ? String(page) : null,
    };
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v) q.set(k, v);
    const s = q.toString();
    return `/hop-thu${s ? `?${s}` : ""}`;
  };

  const sendingOpen = !switches.org.paused && !switches.whatsappGuest.paused;
  const botAutoSend = sendingOpen && !switches.agentGuest.paused;

  return (
    <div className={`stack ${styles.page}`} data-selected={selectedId ? "true" : "false"}>
      <PageHeader
        title="Hộp thư & tổng đài"
        description="Tin nhắn của khách, nhân viên và nhóm. Bot chỉ soạn nháp từ Q&A đã duyệt."
      />

      <div className={styles.statusBar}>
        {connectors.length === 0 ? (
          <span className={styles.statusWarn}>Chưa có kênh nhắn tin nào</span>
        ) : (
          connectors.map((c) => (
            <span key={c.id} className={styles.statusItem} title={`Tin vào gần nhất: ${c.last_inbound_at ? formatInstant(c.last_inbound_at, actor.timezone) : "chưa có"}`}>
              <span className={`${styles.dot} ${c.status === "active" && !c.paused ? styles.dotOk : c.status === "error" ? styles.dotBad : styles.dotIdle}`} />
              {c.label}
              <span className="faint">
                {c.paused ? "tạm dừng" : c.status === "demo" ? "demo" : (CONNECTOR_STATUS_LABELS[c.status] ?? c.status).toLowerCase()}
              </span>
            </span>
          ))
        )}
        <span className="spacer" />
        {!sendingOpen ? (
          <Link href="/agent-center" className={styles.statusWarn} title="Tin trả lời và nháp đã duyệt sẽ ghi “Gửi thất bại” kèm lý do cho tới khi bật ở Agent Center">
            Gửi tin cho khách đang dừng
          </Link>
        ) : !botAutoSend ? (
          <span className={styles.statusItem}>Bot chỉ soạn nháp, chờ người duyệt</span>
        ) : null}
      </div>

      {worker.queued > 0 && !worker.alive ? (
        <Notice tone="danger" title={`${worker.queued} tin đang chờ gửi nhưng worker không chạy`}>
          Chỉ worker gửi tin ra WhatsApp. {worker.lastBeatAt ? `Nhịp cuối ${formatInstant(worker.lastBeatAt, actor.timezone)}.` : "Chưa thấy worker chạy lần nào."} Báo quản trị khởi động worker.
        </Notice>
      ) : null}

      <div className={styles.layout} data-selected={selectedId ? "true" : "false"}>
        <div className={styles.listPane}>
        <Card title={`Hội thoại (${list.total})`} pad={false}>
          <div className={`card-pad ${styles.filters}`}>
            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              <Link className={`btn btn-sm ${!filters.kind ? "btn-primary" : ""}`} href={href({ kind: null, page: null })}>
                Tất cả
              </Link>
              {(["guest", "staff", "group"] as const).map((k) => (
                <Link key={k} className={`btn btn-sm ${filters.kind === k ? "btn-primary" : ""}`} href={href({ kind: k, page: null })}>
                  {KIND_LABELS[k]}
                </Link>
              ))}
            </div>
            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              <Link className={`btn btn-sm ${filters.unread ? "btn-primary" : ""}`} href={href({ unread: filters.unread ? null : "1", page: null })}>
                Chưa đọc
              </Link>
              <Link className={`btn btn-sm ${filters.waiting ? "btn-primary" : ""}`} href={href({ waiting: filters.waiting ? null : "1", page: null })}>
                Đang chờ người
              </Link>
              <form method="get" action="/hop-thu" className="row" style={{ gap: 4 }}>
                {filters.kind ? <input type="hidden" name="kind" value={filters.kind} /> : null}
                {filters.unread ? <input type="hidden" name="unread" value="1" /> : null}
                {filters.waiting ? <input type="hidden" name="waiting" value="1" /> : null}
                <select name="channel" className="select" style={{ width: "auto" }} defaultValue={filters.channel ?? ""} aria-label="Kênh">
                  <option value="">Mọi kênh</option>
                  {Object.entries(INBOX_CHANNEL_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn btn-sm">
                  Lọc
                </button>
              </form>
            </div>
          </div>
          {list.items.length === 0 ? (
            <EmptyState title="Không có hội thoại">
              {filters.kind || filters.unread || filters.waiting || filters.channel ? "Không có hội thoại khớp bộ lọc." : "Chưa có tin nào vào qua connector."}
            </EmptyState>
          ) : (
            <ul className={styles.list}>
              {list.items.map((c) => (
                <li key={c.id}>
                  <Link href={href({ c: c.id })} className={styles.item} aria-current={c.id === selectedId ? "true" : undefined}>
                    <div className="row" style={{ gap: 4, justifyContent: "space-between" }}>
                      <span className="strong">
                        {c.title ?? c.contact_name ?? (c.kind === "group" ? "Nhóm WhatsApp" : "Không tên")} {c.is_demo ? <DemoBadge /> : null}
                      </span>
                      {c.unread_count > 0 ? <Badge tone="info">{c.unread_count} mới</Badge> : null}
                    </div>
                    {c.open_handoffs || c.drafts || c.failed ? (
                      <div className="row small" style={{ gap: 4, flexWrap: "wrap" }}>
                        {c.open_handoffs ? <Badge tone="danger">Chờ người nhận</Badge> : null}
                        {c.failed ? <Badge tone="danger">{c.failed} gửi lỗi</Badge> : null}
                        {c.drafts ? <Badge tone="warn">{c.drafts} nháp chờ duyệt</Badge> : null}
                      </div>
                    ) : null}
                    <div className="small muted">
                      {c.last_direction === "out" ? "↩ " : ""}
                      {c.last_body ?? <span className="faint">(không có chữ)</span>}
                    </div>
                    <div className="small faint">
                      {KIND_LABELS[c.kind] ?? c.kind} · {INBOX_CHANNEL_LABELS[c.channel] ?? c.channel}
                      {c.booking_ref ? ` · ${c.booking_ref}` : ""}
                      {c.kind === "guest" && c.handled_by !== "bot" ? " · người đang tiếp quản" : ""} · {c.last_message_at ? formatInstant(c.last_message_at, actor.timezone) : "—"}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="card-pad">
            <Pagination page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(p) => href({ page: p > 1 ? String(p) : null })} />
          </div>
        </Card>
        </div>

        <div className={`stack ${styles.detailPane}`}>
          {selectedId ? (
            <Link href={href({ c: null })} className={`show-mobile ${styles.back}`}>
              ← Tất cả hội thoại
            </Link>
          ) : null}
          {!selectedId ? (
            <Card>
              <EmptyState title="Chọn một hội thoại">Chọn hội thoại ở danh sách bên trái để xem tin và xử lý.</EmptyState>
            </Card>
          ) : !detail ? (
            <Notice tone="danger" title="Không tìm thấy hội thoại">
              Hội thoại không tồn tại hoặc không thuộc tổ chức của bạn.
            </Notice>
          ) : (
            <ConversationPanel detail={detail} actorId={actor.userId} tz={actor.timezone} perms={perms} users={users} canViewBooking={can(actor, "booking.view")} />
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationPanel({
  detail,
  actorId,
  tz,
  perms,
  users,
  canViewBooking,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getConversationDetail>>>;
  actorId: string | null;
  tz: string;
  perms: ReturnType<typeof canManageInbox>;
  users: { id: string; full_name: string; role: string }[];
  canViewBooking: boolean;
}) {
  const c = detail.conversation;
  const connectorBlocked = c.connector_status === "demo" || c.connector_status === "not_configured" || c.connector_paused;
  return (
    <>
      {c.unread_count > 0 ? <MarkRead conversationId={c.id} /> : null}
      <Card
        title={
          <span className="row" style={{ gap: 6 }}>
            {c.title ?? c.contact_name ?? (c.kind === "group" ? "Nhóm WhatsApp" : "Không tên")} {c.is_demo ? <DemoBadge /> : null}
          </span>
        }
        actions={perms.takeover ? <TakeoverButtons conversationId={c.id} kind={c.kind} handledBy={c.handled_by} mine={c.takeover_by === actorId} /> : null}
      >
        <div className="stack" style={{ gap: 6 }}>
          <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
            <Badge tone="neutral">{KIND_LABELS[c.kind] ?? c.kind}</Badge>
            {c.kind === "guest" ? (
              <Badge tone={c.handled_by === "bot" ? "info" : "ok"}>{c.handled_by === "bot" ? "Bot đang nháp" : `Người đang tiếp quản${c.takeover_name ? `: ${c.takeover_name}` : ""}`}</Badge>
            ) : (
              <Badge tone="ok">Người xử lý (không bot)</Badge>
            )}
            {c.kind === "guest" ? <Badge tone={c.verification_level === "none" ? "warn" : "ok"}>{VERIFICATION_LABELS[c.verification_level]}</Badge> : null}
            {c.connector_label ? (
              <Badge tone={connectorTone(c.connector_status ?? "not_configured")}>
                {c.connector_label}: {c.connector_status === "demo" ? "demo" : CONNECTOR_STATUS_LABELS[c.connector_status ?? ""] ?? c.connector_status}
                {c.connector_paused ? " · tạm dừng" : ""}
              </Badge>
            ) : null}
          </div>
          <div className="small muted">
            {c.contact_handle ? <span className="mono">{c.contact_handle}</span> : c.kind !== "staff" ? <span className="faint">Liên hệ ẩn (cần quyền xem liên hệ khách)</span> : null}
            {c.staff_name ? ` · Nhân viên: ${c.staff_name}` : ""}
            {c.language ? ` · Ngôn ngữ: ${c.language}` : ""}
            {c.takeover_at ? ` · Tiếp quản lúc ${formatInstant(c.takeover_at, tz)}` : ""}
          </div>
          <div className="small">
            Booking:{" "}
            {c.booking_id ? (
              <>
                <Link href={`/bookings/${c.booking_id}`}>{c.booking_ref ?? "(không mã)"}</Link>
                {c.booking_check_in ? ` · ${formatDateVi(c.booking_check_in)} → ${formatDateVi(c.booking_check_out)}` : ""}
                {c.unit_code ? ` · phòng ${c.unit_code}` : ""}
              </>
            ) : c.booking_ref ? (
              c.booking_ref
            ) : (
              <span className="faint">chưa gắn</span>
            )}
            {perms.attachBooking && c.kind !== "group" ? <AttachBooking conversationId={c.id} attached={!!c.booking_id} /> : null}
          </div>
          {connectorBlocked ? (
            <div className="notice notice-warn small">
              {c.connector_status === "demo"
                ? "Hội thoại DEMO — tin trả lời sẽ ghi “Gửi thất bại: connector demo”, không gửi thật."
                : c.connector_paused
                  ? "Connector đang tạm dừng — không gửi được."
                  : "Connector chưa cấu hình — không gửi được."}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title={`Tin nhắn (${detail.messages.length})`}>
        {detail.messages.length === 0 ? (
          <EmptyState title="Chưa có tin" />
        ) : (
          <div className={styles.thread}>
            {detail.messages.map((m) => (
              <div key={m.id} className={`${styles.bubble} ${m.direction === "in" ? styles.in : styles.out} ${m.status === "draft" || m.status === "pending_approval" ? styles.draft : ""} ${m.status === "discarded" ? styles.discarded : ""}`}>
                <div className="row small" style={{ gap: 6, justifyContent: "space-between" }}>
                  <span className="strong">
                    {m.author_type === "bot" ? "Bot Q&A" : m.author_name ?? (m.direction === "in" ? "Khách" : "Nhân viên")}
                  </span>
                  <span className="faint">{formatInstant(m.source_occurred_at ?? m.created_at, tz)}</span>
                </div>
                {m.body ? <div className={styles.body}>{m.body}</div> : <div className="small faint">(không có chữ)</div>}
                {m.attachments?.length ? <div className="small faint">Đính kèm: {m.attachments.map((a) => a.kind).join(", ")} (chưa tải nội dung)</div> : null}
                {m.grounding ? (
                  <div className="small muted">
                    {m.grounding.ai ? (
                      <>
                        <Badge tone="info">AI soạn</Badge> Căn cứ Q&A: {m.grounding.topic ?? "—"}
                        {m.grounding.language ? ` · ngôn ngữ ${m.grounding.language}` : ""}
                      </>
                    ) : (
                      <>
                        Căn cứ Q&A: {m.grounding.topic ?? "—"} · phiên bản {m.grounding.version ?? "?"} · phạm vi {m.grounding.scope ?? "?"} · độ khớp từ khoá{" "}
                        {m.grounding.score != null ? m.grounding.score.toFixed(2) : "?"}
                      </>
                    )}
                    {m.grounding.editedByStaff ? " · đã sửa trước khi gửi" : ""}
                  </div>
                ) : null}
                {m.direction !== "in" ? (
                  <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
                    <Badge tone={MESSAGE_TONES[m.status] ?? "neutral"}>{MESSAGE_STATUS_LABELS[m.status] ?? m.status}</Badge>
                    {m.sent_at ? <span className="faint">gửi {formatInstant(m.sent_at, tz)}</span> : null}
                    {!m.sent_at && m.locked_at && (m.status === "sending" || m.status === "failed") ? (
                      <span className="faint">
                        {m.status === "sending" ? "đang gửi từ" : "thử gửi lúc"} {formatInstant(m.locked_at, tz)}
                      </span>
                    ) : null}
                    {m.approved_name ? <span className="faint">duyệt: {m.approved_name}</span> : null}
                    {(m.status === "failed" || m.status === "discarded") && m.error ?<span style={{ color: "var(--danger)" }}>{sendFailureLabel(m.error)}</span> : null}
                    {m.status === "failed" && perms.reply ? <RetryButton messageId={m.id} uncertain={(m.error ?? "").startsWith("uncertain")} /> : null}
                  </div>
                ) : null}
                {(m.status === "draft" || m.status === "pending_approval") && perms.reply ? <DraftActions messageId={m.id} body={m.body ?? ""} /> : null}
              </div>
            ))}
          </div>
        )}
        {perms.reply ? (
          <div style={{ marginTop: 12 }}>
            <ReplyBox conversationId={c.id} />
          </div>
        ) : (
          <div className="small faint" style={{ marginTop: 12 }}>
            Bạn chỉ có quyền xem hộp thư.
          </div>
        )}
      </Card>

      <Card title={`Chuyển người (${detail.handoffs.length})`} actions={perms.reply ? <RequestHandoff conversationId={c.id} users={users} /> : null}>
        {detail.handoffs.length === 0 ? (
          <EmptyState title="Chưa có yêu cầu chuyển người" />
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {detail.handoffs.map((h) => {
              const ctx = h.context as { bookingRef?: string | null; unitCode?: string | null; verification?: string; language?: string | null; stepsTried?: string[] };
              return (
                <div key={h.id} className={styles.row}>
                  <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className="strong">{handoffReasonLabel(h.reason)}</span>
                    <Badge tone={h.status === "requested" || h.status === "escalated" ? "danger" : h.status === "accepted" ? "ok" : "neutral"}>{HANDOFF_STATUS_LABELS[h.status] ?? h.status}</Badge>
                    <span className="faint">yêu cầu {formatInstant(h.requested_at, tz)}</span>
                    {h.accept_due_at && (h.status === "requested" || h.status === "escalated") ? <span className="faint">hạn nhận {formatInstant(h.accept_due_at, tz)}</span> : null}
                  </div>
                  <div className="small muted">
                    {h.target_name ? `Gửi tới: ${h.target_name} · ` : "Gửi tới: người trực · "}
                    Xác minh: {VERIFICATION_LABELS[ctx.verification ?? "none"] ?? ctx.verification} · Booking: {ctx.bookingRef ?? "—"} · Phòng: {ctx.unitCode ?? "—"} · Ngôn ngữ: {ctx.language ?? "—"}
                    {ctx.stepsTried?.length ? ` · Đã thử: ${ctx.stepsTried.join("; ")}` : ""}
                  </div>
                  {h.accepted_name ? (
                    <div className="small">
                      Đã nhận bởi {h.accepted_name} lúc {formatInstant(h.accepted_at, tz)}
                    </div>
                  ) : null}
                  {perms.takeover && (h.status === "requested" || h.status === "escalated") ? <HandoffButtons handoffId={h.id} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title={`Ticket (${detail.tickets.length})`} actions={perms.tickets ? <CreateTicket conversationId={c.id} /> : null}>
        {detail.tickets.length === 0 ? (
          <EmptyState title="Chưa có ticket" />
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {detail.tickets.map((t) => (
              <div key={t.id} className={styles.row}>
                <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
                  <Badge tone={PRIORITY_TONES[t.priority] ?? "neutral"}>{t.priority}</Badge>
                  <span className="strong">{t.summary}</span>
                  <Badge tone="neutral">{TICKET_CATEGORY_LABELS[t.category] ?? t.category}</Badge>
                  <Badge tone={["resolved", "verified", "closed"].includes(t.status) ? "ok" : t.status === "new" || t.status === "assigned" ? "warn" : "info"}>
                    {TICKET_STATUS_LABELS[t.status] ?? t.status}
                  </Badge>
                </div>
                <div className="small muted">
                  {t.created_by_type === "bot" ? "Bot tạo" : "Người tạo"} {formatInstant(t.created_at, tz)} · Người nhận: {t.assignee_name ?? "chưa giao"}
                  {t.accepted_at ? ` · nhận lúc ${formatInstant(t.accepted_at, tz)}` : t.accept_due_at && (t.status === "new" || t.status === "assigned") ? ` · hạn nhận ${formatInstant(t.accept_due_at, tz)}` : ""}
                </div>
                {perms.tickets ? (
                  <TicketActions ticket={{ id: t.id, status: t.status, version: t.version, assigneeUserId: t.assignee_user_id }} actorId={actorId} users={users} />
                ) : null}
              </div>
            ))}
          </div>
        )}
        {!canViewBooking ? <div className="small faint">Không có quyền xem booking — mã booking được ẩn.</div> : null}
      </Card>
    </>
  );
}
