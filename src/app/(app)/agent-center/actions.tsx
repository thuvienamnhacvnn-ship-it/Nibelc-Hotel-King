"use client";

import { useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";

function ReasonDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger,
  busy,
  error,
  onConfirm,
  reasonRequired = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  error: Parameters<typeof ErrorText>[0]["error"];
  onConfirm: (reason: string) => Promise<boolean>;
  reasonRequired?: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            disabled={busy || (reasonRequired && reason.trim().length < 3)}
            onClick={async () => {
              if (await onConfirm(reason.trim())) setReason("");
            }}
          >
            {busy ? "Đang lưu…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        <div>{description}</div>
        {reasonRequired ? (
          <div className="field">
            <label>Lý do (bắt buộc)</label>
            <textarea className="textarea" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </div>
        ) : null}
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

export function SwitchButton({ scope, switchKey, label, paused }: { scope: string; switchKey: string; label: string; paused: boolean }) {
  const [open, setOpen] = useState(false);
  const { run, busy, error, setError } = useAction();
  const turningOn = paused;
  const close = () => {
    setOpen(false);
    setError(null);
  };
  return (
    <>
      <button type="button" className={`btn btn-sm ${turningOn ? "btn-primary" : "btn-danger"}`} onClick={() => setOpen(true)}>
        {turningOn ? "Cho chạy" : "Dừng"}
      </button>
      <ReasonDialog
        open={open}
        onClose={close}
        title={`${turningOn ? "Cho chạy" : "Dừng"} — ${label}`}
        description={
          turningOn
            ? "Bật lại tự động. Các chốt khác (mẫu tin đã duyệt, hạn mức, số từng nhắn vào tổng đài) vẫn áp dụng. Ghi rõ ai đã đồng ý."
            : "Dừng ngay: việc đang xếp hàng sẽ được ghi “không gửi — đang dừng”, đội vẫn làm tay bình thường."
        }
        confirmLabel={turningOn ? "Xác nhận cho chạy" : "Xác nhận dừng"}
        danger={!turningOn}
        busy={busy}
        error={error}
        onConfirm={async (reason) => {
          const res = await run("/api/v1/manager/switches", { body: { scope, key: switchKey, paused: !turningOn, reason } });
          if (!res.error) setOpen(false);
          return !res.error;
        }}
      />
    </>
  );
}

export function RetryOutboxButton({ id, topic }: { id: string; topic: string }) {
  const [open, setOpen] = useState(false);
  const { run, busy, error, setError } = useAction();
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Thử lại
      </button>
      <ReasonDialog
        open={open}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        title={`Thử lại sự kiện ${topic}`}
        description="Đặt lại trạng thái chờ để worker xử lý lần nữa. Số lần đã thử được giữ nguyên — nếu lỗi tiếp, sự kiện lại chuyển Hỏng. Thao tác được ghi nhật ký."
        confirmLabel="Thử lại"
        reasonRequired={false}
        busy={busy}
        error={error}
        onConfirm={async () => {
          const res = await run(`/api/v1/manager/outbox/${id}/retry`, { body: {} });
          if (!res.error) setOpen(false);
          return !res.error;
        }}
      />
    </>
  );
}

const LANGS = [
  ["vi", "Tiếng Việt"],
  ["en", "English"],
  ["hu", "Magyar"],
  ["de", "Deutsch"],
] as const;

export function TemplateEditor({ initial, keys }: { initial?: { key: string; language: string; body: string; status: string }; keys: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(initial?.key ?? "");
  const [language, setLanguage] = useState(initial?.language ?? "vi");
  const [body, setBody] = useState(initial?.body ?? "");
  const { run, busy, error, setError } = useAction();
  const close = () => {
    setOpen(false);
    setError(null);
  };
  return (
    <>
      <button type="button" className={`btn btn-sm ${initial ? "" : "btn-primary"}`} onClick={() => setOpen(true)}>
        {initial ? "Sửa" : "Soạn mẫu mới"}
      </button>
      <Dialog
        open={open}
        onClose={close}
        title={initial ? `Sửa mẫu ${initial.key} (${initial.language})` : "Soạn mẫu tin mới"}
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Huỷ
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || body.trim().length < 5 || !key}
              onClick={async () => {
                const res = await run("/api/v1/manager/templates", { body: { key, language, body } });
                if (!res.error) setOpen(false);
              }}
            >
              {busy ? "Đang lưu…" : "Lưu nháp"}
            </button>
          </>
        }
      >
        <div className="stack">
          {initial?.status === "approved" ? <div className="notice notice-warn small">Mẫu đang được duyệt. Lưu sửa đổi sẽ đưa mẫu về nháp — tin dùng mẫu này bị chặn tới khi người khác duyệt lại.</div> : null}
          <div className="field">
            <label htmlFor="tpl-key">Mã mẫu</label>
            <input id="tpl-key" className="input mono" list="tpl-keys" value={key} disabled={!!initial} onChange={(e) => setKey(e.target.value.trim())} />
            <datalist id="tpl-keys">
              {Object.entries(keys).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </datalist>
            <div className="hint">Hệ thống dùng: {Object.keys(keys).join(", ")}.</div>
          </div>
          <div className="field">
            <label htmlFor="tpl-lang">Ngôn ngữ</label>
            <select id="tpl-lang" className="select" value={language} disabled={!!initial} onChange={(e) => setLanguage(e.target.value)}>
              {LANGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tpl-body">Nội dung</label>
            <textarea id="tpl-body" className="textarea" rows={6} value={body} maxLength={1500} onChange={(e) => setBody(e.target.value)} />
            <div className="hint">
              Điền dữ liệu bằng <span className="mono">{"{{ten_truong}}"}</span>. Ticket: summary, priority, category, level, overdue_minutes, link. Chuyển người: reason, level, link. Báo cáo: date, kind_label,
              summary, link. Không đưa mã cửa, mật khẩu hay dữ liệu khách vào mẫu.
            </div>
          </div>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function ApproveTemplateButton({ id, label, blockedReason }: { id: string; label: string; blockedReason: string | null }) {
  const [open, setOpen] = useState(false);
  const { run, busy, error, setError } = useAction();
  if (blockedReason)
    return (
      <button type="button" className="btn btn-sm" disabled title={blockedReason}>
        Duyệt
      </button>
    );
  return (
    <>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
        Duyệt
      </button>
      <ReasonDialog
        open={open}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        title={`Duyệt mẫu ${label}`}
        description="Sau khi duyệt, hệ thống được dùng mẫu này để gửi (vẫn qua công tắc và hạn mức). Kiểm kỹ nội dung không chứa mã cửa, mật khẩu, dữ liệu khách."
        confirmLabel="Duyệt mẫu"
        reasonRequired={false}
        busy={busy}
        error={error}
        onConfirm={async () => {
          const res = await run(`/api/v1/manager/templates/${id}/approve`, { body: {} });
          if (!res.error) setOpen(false);
          return !res.error;
        }}
      />
    </>
  );
}

export function RetireTemplateButton({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { run, busy, error, setError } = useAction();
  return (
    <>
      <button type="button" className="btn btn-sm btn-danger" onClick={() => setOpen(true)}>
        Ngừng dùng
      </button>
      <ReasonDialog
        open={open}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        title={`Ngừng dùng mẫu ${label}`}
        description="Tin dùng mẫu này sẽ bị chặn (không gửi) cho tới khi có mẫu mới được duyệt."
        confirmLabel="Ngừng dùng"
        danger
        busy={busy}
        error={error}
        onConfirm={async (reason) => {
          const res = await run(`/api/v1/manager/templates/${id}/retire`, { body: { reason } });
          if (!res.error) setOpen(false);
          return !res.error;
        }}
      />
    </>
  );
}

type Option = { id: string; label: string };

export function AddContactForm({ staff, purposes }: { staff: Option[]; purposes: Option[] }) {
  const [purpose, setPurpose] = useState(purposes[0]?.id ?? "");
  const [level, setLevel] = useState(0);
  const [userId, setUserId] = useState("");
  const { run, busy, error } = useAction();
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await run("/api/v1/manager/escalation-contacts", { body: { purpose, level, userId } });
        if (!res.error) setUserId("");
      }}
    >
      <div className="row" style={{ alignItems: "end" }}>
        <div className="field">
          <label htmlFor="ec-purpose">Mục đích</label>
          <select id="ec-purpose" className="select" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            {purposes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ec-level">Cấp</label>
          <input id="ec-level" type="number" className="input" min={0} max={9} value={level} onChange={(e) => setLevel(Math.max(0, Math.min(9, Number(e.target.value) || 0)))} style={{ width: 80 }} />
        </div>
        <div className="field">
          <label htmlFor="ec-user">Người trực</label>
          <select id="ec-user" className="select" value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">— Chọn —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !userId}>
          {busy ? "Đang thêm…" : "Thêm"}
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

export function ContactActions({ id, level, active, name }: { id: string; level: number; active: boolean; name: string }) {
  const [confirm, setConfirm] = useState(false);
  const { run, busy, error, setError } = useAction();
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={busy || level === 0} title="Lên cấp sớm hơn" onClick={() => run(`/api/v1/manager/escalation-contacts/${id}`, { method: "PATCH", body: { level: level - 1 } })}>
          ↑
        </button>
        <button type="button" className="btn btn-sm" disabled={busy || level >= 9} title="Xuống cấp sau" onClick={() => run(`/api/v1/manager/escalation-contacts/${id}`, { method: "PATCH", body: { level: level + 1 } })}>
          ↓
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(`/api/v1/manager/escalation-contacts/${id}`, { method: "PATCH", body: { active: !active } })}>
          {active ? "Tạm nghỉ" : "Trực lại"}
        </button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirm(true)}>
          Xoá
        </button>
      </div>
      <ErrorText error={confirm ? null : error} />
      <ReasonDialog
        open={confirm}
        onClose={() => {
          setConfirm(false);
          setError(null);
        }}
        title={`Xoá ${name} khỏi danh sách trực`}
        description="Cảnh báo ở cấp này sẽ đi tới người còn lại; không còn ai thì đi thẳng lên Leader."
        confirmLabel="Xoá"
        danger
        reasonRequired={false}
        busy={busy}
        error={error}
        onConfirm={async () => {
          const res = await run(`/api/v1/manager/escalation-contacts/${id}`, { method: "DELETE" });
          if (!res.error) setConfirm(false);
          return !res.error;
        }}
      />
    </div>
  );
}

export function AddSubscriptionForm({ staff }: { staff: Option[] }) {
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState("morning");
  const [channel, setChannel] = useState("whatsapp");
  const [sendTime, setSendTime] = useState("08:00");
  const { run, busy, error } = useAction();
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await run("/api/v1/manager/subscriptions", { body: { userId, kind, channel, sendTime: kind === "p1_alert" ? null : sendTime } });
        if (!res.error) setUserId("");
      }}
    >
      <div className="row" style={{ alignItems: "end" }}>
        <div className="field">
          <label htmlFor="sub-user">Người nhận</label>
          <select id="sub-user" className="select" value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">— Chọn —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sub-kind">Loại</label>
          <select
            id="sub-kind"
            className="select"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              if (e.target.value === "evening") setSendTime("20:00");
              if (e.target.value === "morning") setSendTime("08:00");
            }}
          >
            <option value="morning">Báo cáo đầu ngày</option>
            <option value="evening">Báo cáo cuối ngày</option>
            <option value="p1_alert">Cảnh báo P1</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sub-channel">Kênh</label>
          <select id="sub-channel" className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="whatsapp">WhatsApp</option>
            <option value="inapp">Trong ứng dụng</option>
          </select>
        </div>
        {kind !== "p1_alert" ? (
          <div className="field">
            <label htmlFor="sub-time">Giờ (Budapest)</label>
            <input id="sub-time" type="time" className="input" value={sendTime} onChange={(e) => setSendTime(e.target.value)} required />
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy || !userId}>
          {busy ? "Đang thêm…" : "Thêm (ở trạng thái tắt)"}
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

export function SubscriptionActions({ id, enabled, label }: { id: string; enabled: boolean; label: string }) {
  const [open, setOpen] = useState<null | "toggle" | "delete">(null);
  const { run, busy, error, setError } = useAction();
  const close = () => {
    setOpen(null);
    setError(null);
  };
  return (
    <div className="row">
      <button type="button" className={`btn btn-sm ${enabled ? "btn-danger" : "btn-primary"}`} onClick={() => setOpen("toggle")}>
        {enabled ? "Tắt" : "Bật"}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setOpen("delete")}>
        Xoá
      </button>
      <ReasonDialog
        open={open === "toggle"}
        onClose={close}
        title={`${enabled ? "Tắt" : "Bật"} — ${label}`}
        description={
          enabled
            ? "Ngừng tự lập/gửi báo cáo cho người này."
            : "Giờ 08:00/20:00 là đề xuất — chỉ bật khi Ngọc/Dịu đã chốt giờ và kênh. Gửi thật còn cần công tắc “Gửi báo cáo theo lịch” và mẫu daily_report đã duyệt."
        }
        confirmLabel={enabled ? "Tắt" : "Bật"}
        reasonRequired={!enabled}
        danger={enabled}
        busy={busy}
        error={error}
        onConfirm={async (reason) => {
          const res = await run(`/api/v1/manager/subscriptions/${id}`, { method: "PATCH", body: { enabled: !enabled, ...(reason ? { reason } : {}) } });
          if (!res.error) setOpen(null);
          return !res.error;
        }}
      />
      <ReasonDialog
        open={open === "delete"}
        onClose={close}
        title={`Xoá đăng ký — ${label}`}
        description="Xoá hẳn đăng ký này."
        confirmLabel="Xoá"
        danger
        reasonRequired={false}
        busy={busy}
        error={error}
        onConfirm={async () => {
          const res = await run(`/api/v1/manager/subscriptions/${id}`, { method: "DELETE" });
          if (!res.error) setOpen(null);
          return !res.error;
        }}
      />
    </div>
  );
}
