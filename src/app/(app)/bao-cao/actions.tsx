"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorText, useAction } from "@/components/client";

export function GenerateReportForm({ defaultDate, defaultKind }: { defaultDate: string; defaultKind: "morning" | "evening" }) {
  const router = useRouter();
  const [opsDate, setOpsDate] = useState(defaultDate);
  const [kind, setKind] = useState(defaultKind);
  const { run, busy, error } = useAction();
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await run<{ id: string }>("/api/v1/manager/reports", { body: { opsDate, kind } }, { refresh: false });
        if (res.data) router.push(`/bao-cao?id=${res.data.id}`);
      }}
    >
      <div className="row" style={{ alignItems: "end" }}>
        <div className="field">
          <label htmlFor="r-date">Ngày vận hành (giờ Budapest)</label>
          <input id="r-date" type="date" className="input" value={opsDate} required onChange={(e) => setOpsDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="r-kind">Loại</label>
          <select id="r-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as "morning" | "evening")}>
            <option value="morning">Đầu ngày</option>
            <option value="evening">Cuối ngày</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !opsDate}>
          {busy ? "Đang lập…" : "Lập báo cáo"}
        </button>
      </div>
      <div className="hint">Số liệu chốt tại thời điểm bấm. Báo cáo được lưu dạng nháp — không gửi cho ai.</div>
      <ErrorText error={error} />
    </form>
  );
}

export function CopyPreview({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Đã chép" : "Chép nội dung"}
    </button>
  );
}
