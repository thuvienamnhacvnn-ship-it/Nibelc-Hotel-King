"use client";

import Link from "next/link";
import { useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";
import { Badge, DemoBadge, type Tone } from "@/components/ui";
import { formatDateVi, formatInstant } from "@/lib/time";

export function PauseButton({ connector }: { connector: { id: string; label: string; paused: boolean } }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy, error, setError } = useAction();
  const pausing = !connector.paused;
  const close = () => {
    setOpen(false);
    setError(null);
  };
  return (
    <>
      <button type="button" className={`btn btn-sm ${pausing ? "btn-danger" : ""}`} onClick={() => setOpen(true)}>
        {pausing ? "Tạm dừng" : "Tiếp tục"}
      </button>
      <Dialog
        open={open}
        onClose={close}
        title={`${pausing ? "Tạm dừng" : "Tiếp tục"} nhận sự kiện — ${connector.label}`}
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Huỷ
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || (pausing && reason.trim().length < 3)}
              onClick={async () => {
                const res = await run(`/api/v1/connectors/${connector.id}/pause`, { body: { paused: pausing, reason: reason.trim() || null } });
                if (!res.error) {
                  setOpen(false);
                  setReason("");
                }
              }}
            >
              {busy ? "Đang lưu…" : pausing ? "Xác nhận tạm dừng" : "Xác nhận tiếp tục"}
            </button>
          </>
        }
      >
        <div className="stack">
          <p style={{ margin: 0 }}>
            {pausing
              ? "Khi tạm dừng, sự kiện từ connector này bị từ chối và không cập nhật booking. Cần đối soát lại nguồn sau khi tiếp tục."
              : "Connector sẽ nhận sự kiện trở lại. Sự kiện bị từ chối trong lúc tạm dừng không tự gửi lại — cần đối soát nguồn."}
          </p>
          <div className="field">
            <label htmlFor={`pause-${connector.id}`}>Lý do {pausing ? "(bắt buộc)" : "(tuỳ chọn)"}</label>
            <textarea id={`pause-${connector.id}`} className="textarea" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </div>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}

interface DemoResult {
  scenario: string;
  event: { externalEventId: string; type: string; externalRef: string; sourceVersion: number | null; occurredAt: string | null; checkInDate: string | null; checkOutDate: string | null; listing: string | null };
  result: { status: string; inboundEventId: string | null; bookingId: string | null; message?: string };
  booking: { id: string; external_ref: string | null; booking_status: string; check_in_date: string; check_out_date: string } | null;
}

const RESULT_LABELS: Record<string, [string, Tone]> = {
  applied: ["Đã áp dụng", "ok"],
  duplicate: ["Trùng — không cập nhật lần hai", "neutral"],
  stale: ["Cũ hơn dữ liệu đang lưu — bỏ qua", "neutral"],
  needs_reconcile: ["Cần đối soát nguồn", "warn"],
  conflict: ["Xung đột tồn — đã mở cảnh báo", "danger"],
  failed: ["Lỗi xử lý", "danger"],
};

const SCENARIO_ORDER = ["new", "resend", "stale", "dates", "cancel", "conflict"] as const;

export function DemoFeedPanel({ connector, scenarios }: { connector: { id: string; label: string; paused: boolean }; scenarios: Record<string, string> }) {
  const { run, busy, error } = useAction();
  const [last, setLast] = useState<(DemoResult & { at: string }) | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [ref, setRef] = useState("");

  async function fire(scenario: string) {
    setPending(scenario);
    const res = await run<DemoResult>(`/api/v1/connectors/${connector.id}/demo`, { body: { scenario, externalRef: ref.trim() || null } });
    setPending(null);
    if (res.data) setLast({ ...res.data, at: new Date().toISOString() });
  }

  const label = last ? RESULT_LABELS[last.result.status] ?? [last.result.status, "neutral" as Tone] : null;

  return (
    <section className="card" style={{ borderColor: "#d8b4fe" }}>
      <div className="card-header" style={{ background: "var(--demo-bg)" }}>
        <h2 className="row">
          Nguồn DEMO — {connector.label} <DemoBadge />
        </h2>
      </div>
      <div className="card-pad stack">
        <div className="small" style={{ color: "#4c1d95" }}>
          Sinh sự kiện giả lập (không gọi Airbnb/Booking.com) và đưa qua đúng đường nhận sự kiện thật. Booking tạo ra mang nhãn DEMO. Thời điểm “nguồn phát sinh” là giả lập, lùi vài
          giây so với lúc bấm.
        </div>
        {connector.paused ? <div className="notice notice-warn small">Connector đang tạm dừng — sự kiện sẽ bị từ chối cho tới khi tiếp tục.</div> : null}
        <div className="field" style={{ maxWidth: 360 }}>
          <label htmlFor={`demo-ref-${connector.id}`}>Mã booking kênh (tuỳ chọn)</label>
          <input
            id={`demo-ref-${connector.id}`}
            className="input"
            value={ref}
            onChange={(e) => setRef(e.target.value.toUpperCase())}
            placeholder="Để trống: tự sinh / dùng booking DEMO gần nhất"
            maxLength={40}
          />
          <div className="hint">Với “Kênh đổi ngày / hủy / phiên bản cũ”: chọn booking đích. Với “Booking mới / trùng đêm”: mã cho booking mới.</div>
        </div>
        <div className="row">
          {SCENARIO_ORDER.map((sc) => (
            <button key={sc} type="button" className={`btn ${sc === "cancel" || sc === "conflict" ? "btn-danger" : ""}`} disabled={busy} onClick={() => fire(sc)}>
              {pending === sc ? "Đang gửi…" : scenarios[sc]}
            </button>
          ))}
        </div>
        <ErrorText error={error} />
        {last && label ? (
          <div className="notice notice-info" role="status">
            <div className="stack" style={{ gap: 4 }}>
              <div className="row">
                <span className="strong">{scenarios[last.scenario]}</span> → <Badge tone={label[1]}>{label[0]}</Badge> <DemoBadge />
              </div>
              {last.result.message ? <div className="small">{last.result.message}</div> : null}
              <div className="small">
                Sự kiện <span className="mono">{last.event.externalEventId}</span> · {last.event.type === "booking.cancelled" ? "hủy" : "tạo/cập nhật"} {last.event.externalRef}
                {last.event.sourceVersion != null ? ` · v${last.event.sourceVersion}` : ""}
                {last.event.checkInDate ? ` · ${formatDateVi(last.event.checkInDate)} → ${formatDateVi(last.event.checkOutDate)}` : ""}
                {last.event.listing ? ` · listing ${last.event.listing}` : ""}
              </div>
              <div className="small muted">
                Nguồn phát sinh (giả lập): {formatInstant(last.event.occurredAt)} · bấm lúc {formatInstant(last.at)}
              </div>
              {last.booking ? (
                <div className="small">
                  Booking: <Link href={`/bookings/${last.booking.id}`}>{last.booking.external_ref ?? "(không mã)"}</Link> · {last.booking.booking_status === "cancelled" ? "đã hủy" : "hiệu lực"} ·{" "}
                  {formatDateVi(last.booking.check_in_date)} → {formatDateVi(last.booking.check_out_date)}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
