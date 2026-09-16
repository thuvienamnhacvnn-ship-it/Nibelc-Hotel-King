"use client";

import { useState } from "react";
import { ErrorText, useAction } from "@/components/client";

interface AliasResult {
  created: { code: string; alias: string }[];
  existing: number;
  collisions: { alias: string; codes: string[] }[];
  takenByOtherUnit: { alias: string; code: string; takenBy: string }[];
}

/** Tạo alias từ tên nội bộ của sản phẩm (quyền catalog.edit). */
export function AliasFromNamesButton() {
  const [result, setResult] = useState<AliasResult | null>(null);
  const { run, busy, error } = useAction();
  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            const res = await run<AliasResult>("/api/v1/imports/aliases", { method: "POST", body: {} });
            if (res.data) setResult(res.data);
          }}
        >
          {busy ? "Đang tạo…" : "Tạo alias từ tên sản phẩm"}
        </button>
      </div>
      <ErrorText error={error} />
      {result ? (
        <div className="small">
          <div>
            Tạo mới {result.created.length} · đã có {result.existing} · mơ hồ bỏ qua {result.collisions.length} · đang trỏ sản phẩm khác {result.takenByOtherUnit.length}
          </div>
          {result.collisions.length ? (
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {result.collisions.map((c) => (
                <li key={c.alias}>
                  <span className="mono">{c.alias}</span> — {c.codes.join(", ")}
                </li>
              ))}
            </ul>
          ) : null}
          {result.takenByOtherUnit.length ? (
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {result.takenByOtherUnit.map((c) => (
                <li key={c.alias}>
                  <span className="mono">{c.alias}</span> của {c.code} đang trỏ {c.takenBy}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="hint">Chạy xem trước lại file để các dòng dùng alias mới.</div>
        </div>
      ) : null}
    </div>
  );
}

/** Huỷ lô chưa áp dụng. */
export function DiscardBatchButton({ batchId }: { batchId: string }) {
  const { run, busy, error } = useAction();
  return (
    <div className="stack">
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm("Huỷ lô xem trước này? Các dòng vẫn được giữ để truy vết, nhưng không áp dụng được nữa.")) return;
          await run(`/api/v1/imports/${batchId}/discard`, { method: "POST", body: {} });
        }}
      >
        Huỷ lô
      </button>
      <ErrorText error={error} />
    </div>
  );
}
