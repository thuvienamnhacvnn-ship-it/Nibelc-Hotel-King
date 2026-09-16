"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { type ApiError, callApi, useAction } from "@/components/client";
import styles from "./mobile.module.css";

/** Trạng thái mạng. Mất mạng thì mọi nút ghi bị vô hiệu — không xếp hàng gửi sau, không hiện "đã xong" trước khi server xác nhận. */
export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function MobileOfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className={styles.offline} role="alert" style={{ borderRadius: 0 }}>
      Mất mạng — thao tác chưa gửi, cần mạng. Dữ liệu trên màn hình có thể đã cũ.
    </div>
  );
}

export function MobileLogout() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${styles.logout}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await callApi("/api/v1/auth/logout", { method: "POST", body: {} });
        window.location.href = "/login";
      }}
    >
      Đăng xuất
    </button>
  );
}

function Err({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const missing = (error.details as { missing?: string[] } | undefined)?.missing;
  return (
    <div className={styles.offline} role="alert">
      {error.message}
      {missing?.length ? (
        <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
          {missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface FlowProps {
  taskId: string;
  version: number;
  status: string;
  isAssignee: boolean;
  canManage: boolean;
  changeAckRequired: boolean;
  changeRows: { label: string; before: string | null; after: string }[];
  changeReason: string | null;
  vacancyOk: boolean;
  vacancyMessage: string;
  checklist: { group: string; items: { id: string; label: string; checked: boolean }[] }[];
  /** Khối checklist + ảnh + Hoàn thành khi đang dọn (module photos). Không truyền thì dùng checklist đơn giản bên dưới. */
  inProgressSlot?: ReactNode;
}

const INCIDENT_KINDS: [string, string][] = [
  ["missing_supplies", "Thiếu vật tư"],
  ["maintenance", "Hỏng hóc / cần sửa"],
  ["damage", "Hư hại"],
  ["guest_still_inside", "Khách còn trong phòng"],
  ["access", "Không vào được phòng"],
  ["other", "Khác"],
];

const SEVERITIES: [string, string][] = [
  ["normal", "Bình thường"],
  ["low", "Nhẹ"],
  ["blocking", "Chặn nhận khách (phòng không dùng được)"],
];

export function MobileTaskFlow(p: FlowProps) {
  const router = useRouter();
  const online = useOnline();
  const { run, busy, error } = useAction();
  const [mode, setMode] = useState<null | "decline" | "incident">(null);
  const [reason, setReason] = useState("");
  const [incident, setIncident] = useState({ kind: "missing_supplies", severity: "normal", description: "" });
  const [sentIncident, setSentIncident] = useState(false);
  const [pendingItem, setPendingItem] = useState<string | null>(null);
  const [itemError, setItemError] = useState<ApiError | null>(null);

  const actor = p.isAssignee || p.canManage;
  const disabled = busy || !online || pendingItem !== null;
  const base = `/api/v1/cleaning/tasks/${p.taskId}`;
  const open = !["passed", "cancelled", "awaiting_inspection"].includes(p.status);
  const offlineNote = !online ? <div className={styles.offline}>Chưa gửi — cần mạng</div> : null;

  if (p.changeAckRequired) {
    return (
      <div className={styles.btnRow}>
        {actor ? (
          <button type="button" className={`btn btn-primary ${styles.big}`} disabled={disabled} onClick={() => run(`${base}/ack-change`, { body: { expectedVersion: p.version } })}>
            {busy ? "Đang gửi…" : "Tôi đã đọc và xác nhận"}
          </button>
        ) : null}
        {offlineNote}
        <Err error={error} />
      </div>
    );
  }

  return (
    <div className={styles.btnRow}>
      {offlineNote}
      <Err error={error} />

      {p.isAssignee && ["assigned", "needs_reclean"].includes(p.status) ? (
        <button type="button" className={`btn btn-primary ${styles.big}`} disabled={disabled} onClick={() => run(`${base}/accept`, { body: { expectedVersion: p.version } })}>
          {busy ? "Đang gửi…" : p.status === "needs_reclean" ? "Nhận việc dọn lại" : "Nhận việc"}
        </button>
      ) : null}

      {actor && p.status === "accepted" ? (
        <>
          {!p.vacancyOk ? <div className="notice notice-warn strong">{p.vacancyMessage}</div> : null}
          <button type="button" className={`btn btn-primary ${styles.big}`} disabled={disabled} onClick={() => run(`${base}/start`, { body: { expectedVersion: p.version } })}>
            {busy ? "Đang gửi…" : "Bắt đầu dọn"}
          </button>
        </>
      ) : null}

      {p.status === "in_progress" && p.inProgressSlot ? p.inProgressSlot : null}
      {p.status === "in_progress" && !p.inProgressSlot ? (
        <>
          {p.checklist.map((g) => (
            <div key={g.group} className={styles.group}>
              <h2 className={styles.sectionTitle}>{g.group}</h2>
              {g.items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  role="checkbox"
                  aria-checked={i.checked}
                  className={styles.checkItem}
                  disabled={!actor || disabled}
                  onClick={async () => {
                    setPendingItem(i.id);
                    setItemError(null);
                    const r = await callApi(`${base}/checklist/${i.id}`, { method: "PATCH", body: { checked: !i.checked } });
                    setPendingItem(null);
                    if (r.error) setItemError(r.error);
                    else router.refresh();
                  }}
                >
                  <span className={styles.box} aria-hidden>
                    {i.checked ? "✓" : ""}
                  </span>
                  <span style={{ flex: 1 }}>{i.label}</span>
                  {pendingItem === i.id ? <span className="small">Đang gửi…</span> : null}
                </button>
              ))}
            </div>
          ))}
          <Err error={itemError} />
          <div className="small muted">Chụp ảnh bằng chứng: Đợt 2.</div>
          {actor ? (
            <button type="button" className={`btn btn-primary ${styles.big}`} disabled={disabled} onClick={() => run(`${base}/finish`, { body: { expectedVersion: p.version } })}>
              {busy ? "Đang gửi… (chưa hoàn thành)" : "Hoàn thành"}
            </button>
          ) : null}
        </>
      ) : null}

      {actor && open ? (
        mode === "incident" ? (
          <div className="card card-pad stack">
            <h2 style={{ margin: 0 }}>Báo sự cố</h2>
            <div className="field">
              <label htmlFor="inc-kind">Loại</label>
              <select id="inc-kind" className={`select ${styles.bigInput}`} value={incident.kind} onChange={(e) => setIncident({ ...incident, kind: e.target.value })}>
                {INCIDENT_KINDS.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="inc-sev">Mức độ</label>
              <select id="inc-sev" className={`select ${styles.bigInput}`} value={incident.severity} onChange={(e) => setIncident({ ...incident, severity: e.target.value })}>
                {SEVERITIES.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              {incident.severity === "blocking" ? <div className="strong" style={{ color: "var(--danger)" }}>Phòng sẽ bị đánh dấu ngừng sử dụng cho tới khi điều phối xử lý.</div> : null}
            </div>
            <div className="field">
              <label htmlFor="inc-desc">Mô tả (bắt buộc)</label>
              <textarea id="inc-desc" className={`textarea ${styles.bigInput}`} value={incident.description} onChange={(e) => setIncident({ ...incident, description: e.target.value })} maxLength={2000} />
            </div>
            <button
              type="button"
              className={`btn btn-danger ${styles.big}`}
              disabled={disabled || !incident.description.trim()}
              onClick={async () => {
                const r = await run(`${base}/incidents`, { body: incident });
                if (!r.error) {
                  setMode(null);
                  setSentIncident(true);
                  setIncident({ kind: "missing_supplies", severity: "normal", description: "" });
                }
              }}
            >
              {busy ? "Đang gửi…" : "Gửi báo sự cố"}
            </button>
            <button type="button" className={`btn ${styles.big}`} onClick={() => setMode(null)}>
              Thôi
            </button>
          </div>
        ) : (
          <>
            {sentIncident ? <div className="notice notice-info strong">Máy chủ đã nhận báo sự cố. Điều phối sẽ xử lý.</div> : null}
            <button type="button" className={`btn ${styles.big}`} disabled={!online} onClick={() => setMode("incident")}>
              Báo sự cố
            </button>
          </>
        )
      ) : null}

      {p.isAssignee && ["assigned", "accepted", "needs_reclean"].includes(p.status) ? (
        mode === "decline" ? (
          <div className="card card-pad stack">
            <div className="field">
              <label htmlFor="decline-reason">Lý do từ chối (bắt buộc)</label>
              <textarea id="decline-reason" className={`textarea ${styles.bigInput}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
            </div>
            <button
              type="button"
              className={`btn btn-danger ${styles.big}`}
              disabled={disabled || !reason.trim()}
              onClick={async () => {
                const r = await run(`${base}/decline`, { body: { reason, expectedVersion: p.version } }, { refresh: false });
                if (!r.error) router.push("/m");
              }}
            >
              {busy ? "Đang gửi…" : "Gửi từ chối"}
            </button>
            <button type="button" className={`btn ${styles.big}`} onClick={() => setMode(null)}>
              Thôi
            </button>
          </div>
        ) : (
          <button type="button" className={`btn btn-danger ${styles.big}`} disabled={!online} onClick={() => setMode("decline")}>
            Từ chối việc
          </button>
        )
      ) : null}
    </div>
  );
}
