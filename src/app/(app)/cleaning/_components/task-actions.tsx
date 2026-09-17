"use client";

import { useEffect, useState } from "react";
import { Dialog, ErrorText, MoreMenu, callApi, useAction, type ApiError } from "@/components/client";

/** Hành động điều phối / kiểm phòng trên một việc dọn. Mọi nút gọi API thật; server kiểm quyền lần nữa. */

export interface ActionTask {
  id: string;
  status: string;
  version: number;
  unitCode: string;
  assigneeName: string | null;
  changeAckRequired: boolean;
  vacancyOk: boolean;
  kind: string;
  /** Các dòng trước/sau của thay đổi chờ xác nhận (đã định dạng ở server). */
  changeRows?: { label: string; before: string | null; after: string }[];
  changeReason?: string | null;
}

export interface ActionPerms {
  manage: boolean;
  approve: boolean;
}

interface Suggestion {
  userId: string;
  fullName: string;
  score: number;
  reasons: string[];
  hasShift: boolean;
  tasksThatDay: number;
  maxTasks: number;
}

type Open = null | "assign" | "unassign" | "cancel" | "vacated" | "ack" | "inspect";

const CLOSED = ["passed", "cancelled"];

export function TaskActions({ task, perms, size = "sm" }: { task: ActionTask; perms: ActionPerms; size?: "sm" | "md" }) {
  const [open, setOpen] = useState<Open>(null);
  const btn = size === "sm" ? "btn btn-sm" : "btn";
  const canAssign = perms.manage && ["pending_assignment", "assigned", "accepted", "needs_reclean"].includes(task.status);
  const canUnassign = perms.manage && ["assigned", "accepted"].includes(task.status);
  const canCancel = perms.manage && !CLOSED.includes(task.status);
  const canVacate = perms.manage && !task.vacancyOk && ["pending_assignment", "assigned", "accepted", "needs_reclean"].includes(task.status);
  const canAck = perms.manage && task.changeAckRequired;
  const canInspect = perms.approve && task.status === "awaiting_inspection";
  if (!canAssign && !canUnassign && !canCancel && !canVacate && !canAck && !canInspect) return null;
  const close = () => setOpen(null);

  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
      {canAck ? (
        <button type="button" className={`${btn} btn-primary`} onClick={() => setOpen("ack")}>
          Xác nhận thay đổi
        </button>
      ) : null}
      {canInspect ? (
        <button type="button" className={`${btn} btn-primary`} onClick={() => setOpen("inspect")}>
          Kiểm phòng
        </button>
      ) : null}
      {canAssign ? (
        <button type="button" className={task.status === "pending_assignment" ? `${btn} btn-primary` : btn} onClick={() => setOpen("assign")}>
          {task.assigneeName ? "Đổi người" : "Giao việc"}
        </button>
      ) : null}
      {canVacate || canUnassign || canCancel ? (
        <MoreMenu>
          {canVacate ? (
            <button type="button" className="menu-item" onClick={() => setOpen("vacated")}>
              Xác nhận khách đã rời
            </button>
          ) : null}
          {canUnassign ? (
            <button type="button" className="menu-item" onClick={() => setOpen("unassign")}>
              Bỏ giao
            </button>
          ) : null}
          {canCancel ? (
            <button type="button" className="menu-item danger" onClick={() => setOpen("cancel")}>
              Hủy việc
            </button>
          ) : null}
        </MoreMenu>
      ) : null}

      {open === "assign" ? <AssignDialog task={task} onClose={close} /> : null}
      {open === "unassign" ? (
        <ReasonDialog
          title={`Bỏ giao việc ${task.unitCode}`}
          label="Lý do bỏ giao"
          hint="Việc quay về “Chờ phân công”; cleaner sẽ không còn thấy việc này."
          confirm="Bỏ giao"
          url={`/api/v1/cleaning/tasks/${task.id}/unassign`}
          field="reason"
          onClose={close}
        />
      ) : null}
      {open === "cancel" ? (
        <ReasonDialog
          title={`Hủy việc dọn ${task.unitCode}`}
          label="Lý do hủy"
          hint="Hủy booking không có nghĩa là không cần dọn nếu phòng đã được dùng hoặc còn bẩn. Chỉ hủy khi chắc chắn."
          confirm="Hủy việc"
          danger
          url={`/api/v1/cleaning/tasks/${task.id}/cancel`}
          field="reason"
          onClose={close}
        />
      ) : null}
      {open === "vacated" ? (
        <ReasonDialog
          title={`Xác nhận khách đã rời ${task.unitCode}`}
          label="Căn cứ xác nhận"
          hint="Ví dụ: khách nhắn đã trả chìa lúc 09:40; nhân viên đã kiểm tra phòng trống. Giờ trả phòng dự kiến không phải căn cứ."
          confirm="Xác nhận khách đã rời"
          url={`/api/v1/cleaning/tasks/${task.id}/confirm-vacated`}
          field="note"
          onClose={close}
        />
      ) : null}
      {open === "ack" ? <AckDialog task={task} onClose={close} /> : null}
      {open === "inspect" ? <InspectDialog task={task} onClose={close} /> : null}
    </div>
  );
}

function AssignDialog({ task, onClose }: { task: ActionTask; onClose: () => void }) {
  const { run, busy, error } = useAction();
  const [loaded, setLoaded] = useState<{ items: Suggestion[]; covered: boolean } | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<string>("");
  useEffect(() => {
    let alive = true;
    void callApi<{ items: Suggestion[]; covered: boolean }>(`/api/v1/cleaning/tasks/${task.id}/suggestions`).then((r) => {
      if (!alive) return;
      if (r.error) setLoadError(r.error);
      else setLoaded(r.data ?? { items: [], covered: false });
    });
    return () => {
      alive = false;
    };
  }, [task.id]);
  const pickedName = loaded?.items.find((s) => s.userId === picked)?.fullName;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${task.assigneeName ? "Đổi người làm" : "Giao việc"} — ${task.unitCode}`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Đóng
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!picked || busy}
            onClick={async () => {
              const r = await run(`/api/v1/cleaning/tasks/${task.id}/assign`, { body: { userId: picked, expectedVersion: task.version } });
              if (!r.error) onClose();
            }}
          >
            {busy ? "Đang giao…" : pickedName ? `Giao cho ${pickedName}` : "Chọn cleaner"}
          </button>
        </>
      }
    >
      <div className="stack">
        {task.assigneeName ? <div className="small">Đang giao cho: <strong>{task.assigneeName}</strong></div> : null}
        {["accepted"].includes(task.status) ? (
          <div className="notice notice-warn">Cleaner hiện tại đã nhận việc. Đổi người sẽ đưa việc về “Đã giao” cho người mới.</div>
        ) : null}
        {loadError ? <ErrorText error={loadError} /> : null}
        {!loaded && !loadError ? <div className="muted">Đang tính gợi ý…</div> : null}
        {loaded && loaded.items.length === 0 ? (
          <div className="notice notice-danger" role="alert">
            Không có cleaner nào đang hoạt động. Việc này <strong>chưa được phủ</strong> — vẫn ở trạng thái chờ phân công.
          </div>
        ) : null}
        {loaded && loaded.items.length > 0 && !loaded.covered ? (
          <div className="notice notice-warn" role="status">
            Không cleaner nào vừa có ca vừa còn chỗ trong ngày: việc <strong>chưa được phủ</strong>. Hệ thống không tự giao — nếu vẫn giao, hãy báo trước cho cleaner.
          </div>
        ) : null}
        {loaded?.items.length ? (
          <div className="stack" role="radiogroup" aria-label="Gợi ý cleaner" style={{ gap: 6 }}>
            <div className="hint">Gợi ý xếp theo điểm (ca làm, số việc trong ngày, quen nhà). Bạn quyết định người nhận.</div>
            {loaded.items.map((s) => (
              <label
                key={s.userId}
                className="card card-pad"
                style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", borderColor: picked === s.userId ? "var(--navy-600)" : undefined }}
              >
                <input type="radio" name="cleaner" value={s.userId} checked={picked === s.userId} onChange={() => setPicked(s.userId)} style={{ marginTop: 4 }} />
                <div style={{ flex: 1 }}>
                  <div className="row">
                    <strong>{s.fullName}</strong>
                    <span className="spacer" />
                    <span className={`badge ${s.hasShift && s.tasksThatDay < s.maxTasks ? "badge-ok" : "badge-warn"}`}>{s.score} điểm</span>
                  </div>
                  <div className="small muted">{s.reasons.join(" · ")}</div>
                </div>
              </label>
            ))}
          </div>
        ) : null}
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

function ReasonDialog({
  title,
  label,
  hint,
  confirm,
  danger,
  url,
  field,
  onClose,
}: {
  title: string;
  label: string;
  hint?: string;
  confirm: string;
  danger?: boolean;
  url: string;
  field: "reason" | "note";
  onClose: () => void;
}) {
  const { run, busy, error } = useAction();
  const [text, setText] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Không
          </button>
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy || !text.trim()}
            onClick={async () => {
              const r = await run(url, { body: { [field]: text } });
              if (!r.error) onClose();
            }}
          >
            {busy ? "Đang gửi…" : confirm}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label htmlFor="reason-text">{label} (bắt buộc)</label>
          <textarea id="reason-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
          {hint ? <div className="hint">{hint}</div> : null}
        </div>
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

function AckDialog({ task, onClose }: { task: ActionTask; onClose: () => void }) {
  const { run, busy, error } = useAction();
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Xác nhận thay đổi — ${task.unitCode}`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Để sau
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              const r = await run(`/api/v1/cleaning/tasks/${task.id}/ack-change`, { body: { expectedVersion: task.version } });
              if (!r.error) onClose();
            }}
          >
            {busy ? "Đang xác nhận…" : "Áp dụng thay đổi"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">
          Booking thay đổi khi việc đã được nhận/đang làm nên hệ thống chưa tự đổi. Xác nhận thay cleaner sẽ áp dụng nội dung dưới đây. Nên báo cleaner trước.
        </div>
        {task.changeReason ? <div className="small muted">Lý do: {task.changeReason}</div> : null}
        <ChangeTable rows={task.changeRows ?? []} />
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

export function ChangeTable({ rows }: { rows: { label: string; before: string | null; after: string }[] }) {
  if (!rows.length) return <div className="small muted">Không có trường nào khác với hiện tại.</div>;
  const hasBefore = rows.some((r) => r.before !== null);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Mục</th>
            {hasBefore ? <th>Trước</th> : null}
            <th>Sau</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              {hasBefore ? <td className="muted">{r.before ?? "—"}</td> : null}
              <td className="strong">{r.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InspectDialog({ task, onClose }: { task: ActionTask; onClose: () => void }) {
  const { run, busy, error } = useAction();
  const [result, setResult] = useState<"pass" | "fail" | "">("");
  const [note, setNote] = useState("");
  const needNote = result === "fail";
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Kiểm phòng ${task.unitCode}`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Đóng
          </button>
          <button
            type="button"
            className={result === "fail" ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy || !result || (needNote && !note.trim())}
            onClick={async () => {
              const r = await run(`/api/v1/cleaning/tasks/${task.id}/inspect`, { body: { result, note: note.trim() || null, expectedVersion: task.version } });
              if (!r.error) onClose();
            }}
          >
            {busy ? "Đang lưu…" : result === "fail" ? "Yêu cầu dọn lại" : result === "pass" ? "Duyệt đạt — phòng sẵn sàng" : "Chọn kết quả"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row" role="radiogroup" aria-label="Kết quả kiểm">
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" name="inspect" checked={result === "pass"} onChange={() => setResult("pass")} /> Đạt
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" name="inspect" checked={result === "fail"} onChange={() => setResult("fail")} /> Cần dọn lại
          </label>
        </div>
        <div className="field">
          <label htmlFor="inspect-note">{needNote ? "Hạng mục cần dọn lại (bắt buộc)" : "Ghi chú (không bắt buộc)"}</label>
          <textarea id="inspect-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          <div className="hint">
            Đạt chỉ được duyệt khi checklist đủ và không còn sự cố chặn nhận khách — server sẽ từ chối nếu thiếu.
          </div>
        </div>
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

export function ResolveIncidentButton({ incidentId, label, size = "sm" }: { incidentId: string; label: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={size === "sm" ? "btn btn-sm" : "btn"} onClick={() => setOpen(true)}>
        Xử lý xong
      </button>
      {open ? (
        <ReasonDialog
          title={`Đóng sự cố: ${label}`}
          label="Đã xử lý thế nào"
          hint="Đóng sự cố không tự đánh dấu phòng sẵn sàng — phòng vẫn phải qua kiểm."
          confirm="Đóng sự cố"
          url={`/api/v1/cleaning/incidents/${incidentId}/resolve`}
          field="note"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
