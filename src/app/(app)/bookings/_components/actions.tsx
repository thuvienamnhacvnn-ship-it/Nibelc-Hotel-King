"use client";

import { useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";

/** Áp dụng / Từ chối một yêu cầu thay đổi. Server kiểm quyền booking.approve_change và kiểm tra lại tồn. */
export function ChangeRequestDecision({ id, summary }: { id: string; summary: string }) {
  const [mode, setMode] = useState<"apply" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const { run, busy, error, setError } = useAction();

  function close() {
    setMode(null);
    setNote("");
    setError(null);
  }

  async function submit() {
    if (mode === "reject" && !note.trim()) {
      setError({ code: "invalid_input", message: "Cần ghi lý do từ chối.", status: 422 });
      return;
    }
    const res = await run<{ superseded?: boolean }>(`/api/v1/change-requests/${id}/${mode}`, { method: "POST", body: { note: note.trim() || undefined } });
    if (res.error) return;
    setResult(
      mode === "apply"
        ? res.data?.superseded
          ? "Không áp dụng: booking đã đổi phiên bản sau khi yêu cầu được tạo — yêu cầu chuyển sang hết hiệu lực. Tạo yêu cầu mới nếu vẫn cần."
          : "Đã áp dụng thay đổi."
        : "Đã từ chối yêu cầu.",
    );
    close();
  }

  return (
    <>
      <div className="row">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setMode("apply")}>
          Áp dụng
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => setMode("reject")}>
          Từ chối
        </button>
      </div>
      {result ? <div className="small muted">{result}</div> : null}
      <Dialog
        open={mode !== null}
        onClose={close}
        title={mode === "apply" ? "Áp dụng yêu cầu thay đổi?" : "Từ chối yêu cầu thay đổi"}
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Không
            </button>
            <button type="button" className={`btn ${mode === "apply" ? "btn-primary" : "btn-danger"}`} onClick={submit} disabled={busy}>
              {busy ? "Đang gửi…" : mode === "apply" ? "Áp dụng" : "Từ chối"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="strong">{summary}</div>
          {mode === "apply" ? (
            <p className="small muted" style={{ margin: 0 }}>
              Hệ thống kiểm tra lại tồn phòng và sức chứa ngay lúc áp dụng. Nếu không đạt, booking giữ nguyên và kết quả kiểm tra mới được lưu vào yêu cầu.
            </p>
          ) : null}
          <div className="field">
            <label htmlFor={`cr-note-${id}`}>{mode === "reject" ? "Lý do từ chối (bắt buộc)" : "Ghi chú (không bắt buộc)"}</label>
            <textarea id={`cr-note-${id}`} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </div>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}

/** Đánh dấu xung đột tồn đã xử lý. Chỉ ghi nhận — không hủy hay đổi booking nào. */
export function ResolveConflictButton({ id, summary }: { id: string; summary: string }) {
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  const { run, busy, error, setError } = useAction();

  function close() {
    setOpen(false);
    setResolution("");
    setError(null);
  }

  async function submit() {
    if (!resolution.trim()) {
      setError({ code: "invalid_input", message: "Cần ghi cách đã xử lý.", status: 422 });
      return;
    }
    const res = await run(`/api/v1/conflicts/${id}/resolve`, { method: "POST", body: { resolution: resolution.trim() } });
    if (!res.error) close();
  }

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Đã xử lý
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Đánh dấu xung đột đã xử lý"
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Không
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? "Đang gửi…" : "Xác nhận đã xử lý"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="strong">{summary}</div>
          <p className="small muted" style={{ margin: 0 }}>
            Thao tác này chỉ ghi nhận cách xử lý (ví dụ đã chuyển khách sang phòng khác qua yêu cầu thay đổi, đã liên hệ kênh). Hệ thống không tự hủy booking của khách.
          </p>
          <div className="field">
            <label htmlFor={`resolve-${id}`}>Cách đã xử lý (bắt buộc)</label>
            <textarea id={`resolve-${id}`} className="textarea" value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={2000} />
          </div>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}
