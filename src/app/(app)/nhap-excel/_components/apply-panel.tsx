"use client";

import { useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";

interface ApplyResult {
  applied: number;
  alreadyImported: number;
  errors: number;
  skipped: number;
}

/** Áp dụng các dòng hợp lệ của lô. Server kiểm quyền import.apply và từ chối file đã áp dụng. */
export function ApplyPanel({ batchId, readyCount, today, todayLabel }: { batchId: string; readyCount: number; today: string; todayLabel: string }) {
  const [open, setOpen] = useState(false);
  const [skipPast, setSkipPast] = useState(true);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const { run, busy, error, setError } = useAction();

  async function apply() {
    const res = await run<ApplyResult>(`/api/v1/imports/${batchId}/apply`, { method: "POST", body: { skipCheckOutBefore: skipPast ? today : null } });
    if (res.data) {
      setResult(res.data);
      setOpen(false);
    }
  }

  return (
    <div className="stack">
      <label className="row small" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" checked={skipPast} onChange={(e) => setSkipPast(e.target.checked)} disabled={busy} />
        <span>
          Chỉ nhập booking có ngày trả phòng từ hôm nay ({todayLabel}) trở đi.
          <span className="hint" style={{ display: "block" }}>
            Booking đã trả phòng sẽ được đánh dấu "Không áp dụng" thay vì tạo mới — tránh sinh hàng loạt việc dọn quá hạn cho lịch sử. Bỏ chọn nếu muốn nhập cả lịch sử.
          </span>
        </span>
      </label>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          disabled={busy || readyCount === 0}
        >
          Áp dụng {readyCount} dòng hợp lệ
        </button>
      </div>
      {result ? (
        <div className="notice notice-info" role="status">
          <div>
            Đã xử lý: tạo {result.applied} booking · đã có sẵn {result.alreadyImported} · lỗi {result.errors} · không áp dụng {result.skipped}. Xem các dòng lỗi ở bộ lọc &quot;Lỗi khi áp dụng&quot;.
          </div>
        </div>
      ) : null}
      <ErrorText error={open ? null : error} />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Áp dụng lô nhập?"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
              Huỷ
            </button>
            <button type="button" className="btn btn-primary" onClick={apply} disabled={busy}>
              {busy ? "Đang áp dụng…" : "Áp dụng"}
            </button>
          </>
        }
      >
        <p>
          Tạo booking cho tối đa <strong>{readyCount}</strong> dòng hợp lệ, mỗi dòng một giao dịch. Dòng trùng tồn phòng hoặc lỗi sẽ được đánh dấu lỗi kèm lý do, không dừng cả lô. Dòng cần kiểm tra
          và mã lặp không được nhập.
        </p>
        <p className="small muted">
          {skipPast ? `Dòng có ngày trả phòng trước ${todayLabel} sẽ không được nhập.` : "Nhập cả booking đã trả phòng (trạng thái ở: Chưa rõ)."} Một file chỉ áp dụng được một lần.
        </p>
        <ErrorText error={error} />
      </Dialog>
    </div>
  );
}
