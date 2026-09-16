"use client";

import { ErrorText, useAction } from "@/components/client";

/** Ghi lại kết quả luật + một lượt AI. Không đổi trạng thái việc. */
export function RerunReviewButton({ taskId }: { taskId: string }) {
  const { run, busy, error } = useAction();
  return (
    <span className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(`/api/v1/photos/tasks/${taskId}/review`, { body: {} })}>
        {busy ? "Đang kiểm…" : "Kiểm lại ảnh"}
      </button>
      <ErrorText error={error} />
    </span>
  );
}
