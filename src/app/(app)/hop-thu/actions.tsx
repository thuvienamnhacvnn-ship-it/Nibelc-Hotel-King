"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";
import { Badge } from "@/components/ui";
import { formatDateVi } from "@/lib/time";
import { TICKET_CATEGORY_LABELS, TICKET_STATUS_LABELS, TICKET_TRANSITIONS } from "@/modules/inbox/labels";

interface SendOutcome {
  messageId: string;
  status: string;
}

function SendResultText({ result }: { result: SendOutcome | null }) {
  if (!result) return null;
  return (
    <div className="small muted" role="status">
      Đã xếp hàng gửi. Worker gửi tuần tự (tối đa 1 tin/3 giây mỗi số) — trạng thái thật (đã gửi / thất bại + lý do) hiện trong khung tin.
    </div>
  );
}

/** Mở hội thoại có tin chưa đọc thì đánh dấu đã đọc một lần. */
export function MarkRead({ conversationId }: { conversationId: string }) {
  const { run } = useAction();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (done.current === conversationId) return;
    done.current = conversationId;
    void run(`/api/v1/inbox/conversations/${conversationId}/read`, { method: "POST", body: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  return null;
}

export function TakeoverButtons({ conversationId, kind, handledBy, mine }: { conversationId: string; kind: string; handledBy: "bot" | "human"; mine: boolean }) {
  const { run, busy, error } = useAction();
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 4 }}>
        {handledBy === "bot" || !mine ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(`/api/v1/inbox/conversations/${conversationId}/takeover`, { body: {} })}>
            {busy ? "Đang lưu…" : "Tiếp quản"}
          </button>
        ) : null}
        {kind === "guest" && handledBy === "human" ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(`/api/v1/inbox/conversations/${conversationId}/release`, { body: {} })}>
            Trả cho bot
          </button>
        ) : null}
      </div>
      <ErrorText error={error} />
    </div>
  );
}

export function ReplyBox({ conversationId }: { conversationId: string }) {
  const [body, setBody] = useState("");
  const [result, setResult] = useState<SendOutcome | null>(null);
  const { run, busy, error } = useAction();
  return (
    <form
      className="stack"
      style={{ gap: 6 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setResult(null);
        const res = await run<SendOutcome>(`/api/v1/inbox/conversations/${conversationId}/messages`, { body: { body: body.trim() } });
        if (res.data) {
          setResult(res.data);
          setBody("");
        }
      }}
    >
      <label className="label" htmlFor={`reply-${conversationId}`}>
        Trả lời (gửi qua kênh của hội thoại)
      </label>
      <textarea id={`reply-${conversationId}`} className="textarea" rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || body.trim().length === 0}>
          {busy ? "Đang gửi…" : "Gửi"}
        </button>
        <span className="small faint">Không gửi mã cửa qua đây khi khách chưa được xác thực bổ sung.</span>
      </div>
      <ErrorText error={error} />
      <SendResultText result={result} />
    </form>
  );
}

export function DraftActions({ messageId, body }: { messageId: string; body: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [result, setResult] = useState<SendOutcome | null>(null);
  const { run, busy, error } = useAction();
  const approve = async () => {
    const res = await run<SendOutcome>(`/api/v1/inbox/messages/${messageId}/approve`, { body: editing ? { body: text.trim() } : {} });
    if (res.data) {
      setResult(res.data);
      setEditing(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      {editing ? <textarea className="textarea" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} aria-label="Sửa nháp" /> : null}
      <div className="row" style={{ gap: 4 }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || (editing && text.trim().length === 0)} onClick={approve}>
          {busy ? "Đang gửi…" : editing ? "Duyệt bản đã sửa & gửi" : "Duyệt & gửi"}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? "Thôi sửa" : "Sửa"}
        </button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmDiscard(true)}>
          Huỷ nháp
        </button>
      </div>
      <ErrorText error={error} />
      <SendResultText result={result} />
      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Huỷ nháp của bot?"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirmDiscard(false)} disabled={busy}>
              Không
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                const res = await run(`/api/v1/inbox/messages/${messageId}/discard`, { body: {} });
                if (!res.error) setConfirmDiscard(false);
              }}
            >
              Huỷ nháp
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>Nháp sẽ không được gửi. Khách chưa nhận được câu trả lời — nhớ trả lời thủ công hoặc chuyển người.</p>
        <ErrorText error={error} />
      </Dialog>
    </div>
  );
}

export function RetryButton({ messageId, uncertain }: { messageId: string; uncertain: boolean }) {
  const { run, busy, error } = useAction();
  const [confirm, setConfirm] = useState(false);
  const retry = async () => {
    const res = await run(`/api/v1/inbox/messages/${messageId}/retry`, { body: {} });
    if (!res.error) setConfirm(false);
  };
  return (
    <>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => (uncertain ? setConfirm(true) : retry())}>
        {busy ? "Đang xếp hàng…" : "Gửi lại"}
      </button>
      <ErrorText error={confirm ? null : error} />
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Tin này có thể ĐÃ tới khách"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(false)} disabled={busy}>
              Không gửi lại
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={retry}>
              Đã kiểm trên điện thoại — gửi lại
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Lần gửi trước không rõ kết quả (hết thời gian chờ hoặc mất kết nối sau khi đã gọi Evolution). Mở WhatsApp trên điện thoại tổng đài, kiểm tin đã tới khách chưa. Gửi lặp
          làm tăng nguy cơ số bị WhatsApp khoá.
        </p>
        <ErrorText error={error} />
      </Dialog>
    </>
  );
}

interface BookingHit {
  id: string;
  external_ref: string | null;
  source_channel: string;
  booking_status: string;
  check_in_date: string;
  check_out_date: string;
  guest_name: string | null;
  units: string | null;
  is_demo: boolean;
}

export function AttachBooking({ conversationId, attached }: { conversationId: string; attached: boolean }) {
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState("");
  const [hits, setHits] = useState<BookingHit[] | null>(null);
  const search = useAction();
  const save = useAction();
  const close = () => {
    setOpen(false);
    setHits(null);
    search.setError(null);
    save.setError(null);
  };
  return (
    <>
      <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setOpen(true)}>
        {attached ? "Đổi / bỏ booking" : "Gắn booking"}
      </button>
      <Dialog open={open} onClose={close} title="Gắn booking vào hội thoại">
        <div className="stack">
          <p className="small" style={{ margin: 0 }}>
            Chỉ gắn khi đã đối chiếu mã booking + tên người đặt + ngày lưu trú với khách. Gắn nhầm sẽ để bot trả lời theo phòng của khách khác.
          </p>
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await search.run<{ items: BookingHit[] }>(`/api/v1/inbox/bookings?ref=${encodeURIComponent(ref.trim())}`, {}, { refresh: false });
              if (res.data) setHits(res.data.items);
            }}
          >
            <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Mã booking (ít nhất 3 ký tự)" maxLength={60} aria-label="Mã booking" />
            <button type="submit" className="btn" disabled={search.busy || ref.trim().length < 3}>
              {search.busy ? "Đang tìm…" : "Tìm"}
            </button>
          </form>
          <ErrorText error={search.error} />
          {hits && hits.length === 0 ? <div className="small faint">Không có booking khớp mã.</div> : null}
          {hits?.map((b) => (
            <div key={b.id} className="row small" style={{ justifyContent: "space-between", borderBottom: "1px solid #eee", paddingBottom: 6 }}>
              <span>
                <span className="strong">{b.external_ref ?? "(không mã)"}</span> {b.is_demo ? <Badge tone="demo">DEMO</Badge> : null} · {formatDateVi(b.check_in_date)} → {formatDateVi(b.check_out_date)}
                {b.units ? ` · ${b.units}` : ""}
                {b.guest_name ? ` · ${b.guest_name}` : ""}
                {b.booking_status === "cancelled" ? " · đã hủy" : ""}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={save.busy}
                onClick={async () => {
                  const res = await save.run(`/api/v1/inbox/conversations/${conversationId}/booking`, { body: { bookingId: b.id } });
                  if (!res.error) close();
                }}
              >
                Gắn
              </button>
            </div>
          ))}
          {attached ? (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={save.busy}
              onClick={async () => {
                const res = await save.run(`/api/v1/inbox/conversations/${conversationId}/booking`, { body: { bookingId: null } });
                if (!res.error) close();
              }}
            >
              Bỏ gắn booking hiện tại
            </button>
          ) : null}
          <ErrorText error={save.error} />
        </div>
      </Dialog>
    </>
  );
}

export function HandoffButtons({ handoffId }: { handoffId: string }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy, error, setError } = useAction();
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 4 }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(`/api/v1/inbox/handoffs/${handoffId}/accept`, { body: {} })}>
          {busy ? "Đang lưu…" : "Tôi nhận"}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setCancelOpen(true)}>
          Huỷ yêu cầu
        </button>
      </div>
      <ErrorText error={cancelOpen ? null : error} />
      <Dialog
        open={cancelOpen}
        onClose={() => {
          setCancelOpen(false);
          setError(null);
        }}
        title="Huỷ yêu cầu chuyển người"
        footer={
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || reason.trim().length < 3}
            onClick={async () => {
              const res = await run(`/api/v1/inbox/handoffs/${handoffId}/cancel`, { body: { reason: reason.trim() } });
              if (!res.error) setCancelOpen(false);
            }}
          >
            Xác nhận huỷ
          </button>
        }
      >
        <div className="field">
          <label htmlFor={`hc-${handoffId}`}>Lý do (bắt buộc)</label>
          <textarea id={`hc-${handoffId}`} className="textarea" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ErrorText error={error} />
      </Dialog>
    </div>
  );
}

type UserOpt = { id: string; full_name: string };

export function RequestHandoff({ conversationId, users }: { conversationId: string; users: UserOpt[] }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [priority, setPriority] = useState("P2");
  const { run, busy, error, setError } = useAction();
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Yêu cầu chuyển người
      </button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        title="Yêu cầu chuyển người"
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || reason.trim().length < 3}
            onClick={async () => {
              const res = await run(`/api/v1/inbox/conversations/${conversationId}/handoffs`, { body: { reason: reason.trim(), targetUserId: target || null, priority } });
              if (!res.error) {
                setOpen(false);
                setReason("");
              }
            }}
          >
            {busy ? "Đang gửi…" : "Tạo yêu cầu"}
          </button>
        }
      >
        <div className="stack">
          <p className="small" style={{ margin: 0 }}>
            Tạo handoff + ticket và xếp thông báo cho người nhận. Chỉ ghi “đã có người nhận” khi người đó bấm nhận.
          </p>
          <div className="field">
            <label htmlFor={`hr-${conversationId}`}>Lý do / vấn đề (bắt buộc)</label>
            <textarea id={`hr-${conversationId}`} className="textarea" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`ht-${conversationId}`}>Người nhận</label>
            <select id={`ht-${conversationId}`} className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Người trực theo lịch</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`hp-${conversationId}`}>Mức ưu tiên</label>
            <select id={`hp-${conversationId}`} className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="P0">P0 — nguy hiểm (nhận trong 5 phút)</option>
              <option value="P1">P1 — khẩn (nhận trong 5 phút)</option>
              <option value="P2">P2 — thường (nhận trong 15 phút)</option>
            </select>
          </div>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function CreateTicket({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState("question");
  const [priority, setPriority] = useState("P2");
  const { run, busy, error, setError } = useAction();
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Tạo ticket
      </button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        title="Tạo ticket"
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || summary.trim().length < 3}
            onClick={async () => {
              const res = await run("/api/v1/inbox/tickets", { body: { conversationId, category, priority, summary: summary.trim() } });
              if (!res.error) {
                setOpen(false);
                setSummary("");
              }
            }}
          >
            {busy ? "Đang lưu…" : "Tạo"}
          </button>
        }
      >
        <div className="stack">
          <div className="field">
            <label htmlFor={`ts-${conversationId}`}>Tóm tắt (bắt buộc)</label>
            <input id={`ts-${conversationId}`} className="input" maxLength={300} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`tc-${conversationId}`}>Loại</label>
            <select id={`tc-${conversationId}`} className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(TICKET_CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`tp-${conversationId}`}>Mức ưu tiên</label>
            <select id={`tp-${conversationId}`} className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="P0">P0 — nguy hiểm</option>
              <option value="P1">P1 — khẩn (nhận trong 5 phút)</option>
              <option value="P2">P2 — thường (nhận trong 15 phút)</option>
            </select>
          </div>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}

const NOTE_REQUIRED = (from: string, to: string) => (to === "closed" && (from === "new" || from === "assigned")) || (from === "resolved" && to === "in_progress");

export function TicketActions({ ticket, actorId, users }: { ticket: { id: string; status: string; version: number; assigneeUserId: string | null }; actorId: string | null; users: UserOpt[] }) {
  const { run, busy, error } = useAction();
  const [assignee, setAssignee] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const next = TICKET_TRANSITIONS[ticket.status] ?? [];
  const open = !["resolved", "verified", "closed"].includes(ticket.status);
  const canAccept = (ticket.status === "new" || ticket.status === "assigned") && (!ticket.assigneeUserId || ticket.assigneeUserId === actorId);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
        {canAccept ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(`/api/v1/inbox/tickets/${ticket.id}/accept`, { body: { expectedVersion: ticket.version } })}>
            Nhận ticket
          </button>
        ) : null}
        {open ? (
          <>
            <select className="select" style={{ width: "auto" }} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Giao cho">
              <option value="">Giao cho…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !assignee}
              onClick={async () => {
                const res = await run(`/api/v1/inbox/tickets/${ticket.id}/assign`, { body: { assigneeUserId: assignee, expectedVersion: ticket.version } });
                if (!res.error) setAssignee("");
              }}
            >
              Giao
            </button>
          </>
        ) : null}
        {next.map((s) => (
          <button
            key={s}
            type="button"
            className={`btn btn-sm ${s === "closed" ? "btn-danger" : ""}`}
            disabled={busy}
            onClick={() => {
              setNote("");
              setPending(s);
            }}
          >
            → {TICKET_STATUS_LABELS[s] ?? s}
          </button>
        ))}
      </div>
      <ErrorText error={pending ? null : error} />
      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={`Chuyển ticket sang “${pending ? TICKET_STATUS_LABELS[pending] ?? pending : ""}”`}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (!!pending && NOTE_REQUIRED(ticket.status, pending) && note.trim().length < 3)}
            onClick={async () => {
              const res = await run(`/api/v1/inbox/tickets/${ticket.id}/status`, { body: { status: pending, expectedVersion: ticket.version, note: note.trim() || null } });
              if (!res.error) setPending(null);
            }}
          >
            Xác nhận
          </button>
        }
      >
        <div className="field">
          <label htmlFor={`tn-${ticket.id}`}>Ghi chú {pending && NOTE_REQUIRED(ticket.status, pending) ? "(bắt buộc)" : "(tuỳ chọn)"}</label>
          <textarea id={`tn-${ticket.id}`} className="textarea" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <ErrorText error={error} />
      </Dialog>
    </div>
  );
}
