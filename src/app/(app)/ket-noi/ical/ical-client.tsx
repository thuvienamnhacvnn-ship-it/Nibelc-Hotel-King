"use client";

import { useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";

const CHANNEL: Record<string, string> = { airbnb: "Airbnb", booking_com: "Booking.com" };

export function AddFeedForm({ listings }: { listings: { id: string; channel: string; listing_name: string | null; unit_code: string }[] }) {
  const { run, busy, error } = useAction();
  const [listingId, setListingId] = useState("");
  const [url, setUrl] = useState("");
  if (!listings.length) return <p className="small muted">Mọi listing Airbnb/Booking.com đã có link iCal (hoặc chưa có listing nào).</p>;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await run("/api/v1/ical-feeds", { body: { listingId, url } });
        if (!res.error) {
          setUrl("");
          setListingId("");
        }
      }}
    >
      <h3>Thêm link iCal</h3>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="ical-listing">Listing</label>
          <select id="ical-listing" className="select" value={listingId} onChange={(e) => setListingId(e.target.value)} required>
            <option value="">— Chọn —</option>
            {listings.map((l) => (
              <option key={l.id} value={l.id}>
                {l.unit_code} · {CHANNEL[l.channel] ?? l.channel} · {l.listing_name ?? ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ical-url">Link xuất lịch (.ics)</label>
          <input id="ical-url" className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.airbnb.com/calendar/ical/…" required />
          <span className="hint">Link chứa mã bí mật: hệ thống chỉ hiện dạng che, không ghi vào nhật ký.</span>
        </div>
      </div>
      <ErrorText error={error} />
      <div>
        <button className="btn btn-primary" disabled={busy || !listingId || !url}>
          {busy ? "Đang lưu…" : "Lưu link"}
        </button>
      </div>
    </form>
  );
}

/** Bật/tắt "Giữ chỗ theo lịch kênh" cho một link: bật thì lịch bận của kênh sinh chặn tồn, tắt thì gỡ hết chặn đó. */
export function HoldToggle({ id, holdMode, holdBlocks, canManage }: { id: string; holdMode: string; holdBlocks: number; canManage: boolean }) {
  const { run, busy, error } = useAction();
  const [confirm, setConfirm] = useState(false);
  const on = holdMode === "block";
  const label = on ? `Bật${holdBlocks ? ` · ${holdBlocks} chặn` : ""}` : "Tắt";
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className={`badge badge-${on ? "ok" : "neutral"}`}>{label}</span>
      {canManage ? (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirm(true)}>
          {on ? "Tắt giữ chỗ" : "Bật giữ chỗ"}
        </button>
      ) : null}
      <ErrorText error={error} />
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={on ? "Tắt giữ chỗ theo lịch kênh?" : "Bật giữ chỗ theo lịch kênh?"}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(false)}>
              Huỷ
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                const res = await run(`/api/v1/ical-feeds/${id}`, { method: "PATCH", body: { holdMode: on ? "off" : "block" } });
                if (!res.error) setConfirm(false);
              }}
            >
              {on ? "Tắt" : "Bật"}
            </button>
          </>
        }
      >
        {on ? (
          <p>Mọi chặn tồn do link này sinh ra sẽ được gỡ ngay, phòng mở bán lại trong hệ thống. Booking của khách không bị ảnh hưởng.</p>
        ) : (
          <p>
            Mỗi khoảng bận đọc được từ kênh sẽ chặn tồn phòng của link này, nên hệ thống không bán trùng những đêm đó. Đêm đang có booking hoặc chặn tay thì giữ nguyên — hệ thống chỉ
            chặn phần còn trống, không bao giờ chặn đè. Bật xong bấm &quot;Đồng bộ ngay&quot; để áp dụng.
          </p>
        )}
      </Dialog>
    </div>
  );
}

export function FeedActions({ id, canManage }: { id: string; canManage: boolean }) {
  const { run, busy, error } = useAction();
  const [result, setResult] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={async () => {
            setResult(null);
            const res = await run<{ ok: boolean; events?: number; open?: number; error?: string; hold?: { created: number; released: number; skipped: number } }>(
              `/api/v1/ical-feeds/${id}/sync`,
              { method: "POST", body: {} },
            );
            if (res.data) {
              const h = res.data.hold;
              const holdText =
                h && (h.created || h.released || h.skipped) ? ` · giữ chỗ: thêm ${h.created}, gỡ ${h.released}${h.skipped ? `, ${h.skipped} khoảng đụng booking/chặn tay nên chưa chặn hết` : ""}` : "";
              setResult(res.data.ok ? `Đã đọc ${res.data.events} sự kiện, ${res.data.open} lệch${holdText}` : `Không tải được: ${res.data.error}`);
            }
          }}
        >
          {busy ? "Đang đồng bộ…" : "Đồng bộ ngay"}
        </button>
        {canManage ? (
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}>
            Xoá link
          </button>
        ) : null}
      </div>
      {result ? <span className="small">{result}</span> : null}
      <ErrorText error={error} />
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Xoá link iCal?"
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(false)}>
              Huỷ
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                const res = await run(`/api/v1/ical-feeds/${id}`, { method: "DELETE" });
                if (!res.error) setConfirm(false);
              }}
            >
              Xoá
            </button>
          </>
        }
      >
        Các lệch lịch của link này cũng bị xoá, chặn tồn do link sinh ra được gỡ. Booking trong hệ thống không bị ảnh hưởng.
      </Dialog>
    </div>
  );
}

export function FindingActions({ id }: { id: string }) {
  const { run, busy, error } = useAction();
  const [open, setOpen] = useState<"resolved" | "dismissed" | null>(null);
  const [note, setNote] = useState("");
  return (
    <>
      <div className="row">
        <button className="btn btn-sm" onClick={() => setOpen("resolved")}>
          Đã xử lý
        </button>
        <button className="btn btn-sm" onClick={() => setOpen("dismissed")}>
          Bỏ qua
        </button>
      </div>
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === "resolved" ? "Đánh dấu đã xử lý" : "Bỏ qua lệch này"}
        footer={
          <>
            <button className="btn" onClick={() => setOpen(null)}>
              Huỷ
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !note.trim()}
              onClick={async () => {
                const res = await run(`/api/v1/ical-findings/${id}/resolve`, { body: { status: open, note } });
                if (!res.error) setOpen(null);
              }}
            >
              Lưu
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor={`note-${id}`}>Đã làm gì / vì sao bỏ qua</label>
          <textarea id={`note-${id}`} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: đã nhập booking HM… từ Airbnb; hoặc: đêm chủ nhà tự khoá trên kênh" />
        </div>
        <ErrorText error={error} />
        <p className="small muted">Nếu lần đồng bộ sau vẫn thấy lệch, hệ thống sẽ mở lại.</p>
      </Dialog>
    </>
  );
}
