"use client";

import { Ban } from "lucide-react";
import { useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";
import { addDays, diffDays, formatDateVi, isValidDate } from "@/lib/time";

interface UnitOption {
  id: string;
  code: string;
  name: string;
  kind: string;
  property_code: string;
  active: boolean;
}

export function CreateBlockButton({ units, defaultStart }: { units: UnitOption[]; defaultStart: string }) {
  const [open, setOpen] = useState(false);
  const [unitId, setUnitId] = useState("");
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(addDays(defaultStart, 1));
  const [reason, setReason] = useState("");
  const { run, busy, error, setError } = useAction();

  const unit = units.find((u) => u.id === unitId);
  const datesOk = isValidDate(start) && isValidDate(end) && end > start;
  const nights = datesOk ? diffDays(start, end) : 0;
  const ready = !!unit && datesOk && reason.trim().length >= 3;
  const groups = [...new Set(units.map((u) => u.property_code))];

  function close() {
    setOpen(false);
    setError(null);
  }

  async function submit() {
    const res = await run("/api/v1/inventory-blocks", { body: { unitId, startDate: start, endDate: end, reason } });
    if (!res.error) {
      setOpen(false);
      setReason("");
    }
  }

  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Ban size={16} /> Chặn tồn
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Chặn tồn phòng"
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Huỷ
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={!ready || busy}>
              {busy ? "Đang chặn…" : "Xác nhận chặn"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="field">
            <label htmlFor="blk-unit">Phòng / sản phẩm</label>
            <select id="blk-unit" className="select" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">— Chọn —</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {units
                    .filter((u) => u.property_code === g)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.code} — {u.name}
                        {!u.active ? " (ngừng)" : ""}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="blk-start">Từ đêm</label>
              <input id="blk-start" type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="blk-end">Mở lại từ ngày</label>
              <input id="blk-end" type="date" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="blk-reason">Lý do (bắt buộc)</label>
            <textarea id="blk-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ví dụ: bảo trì máy lạnh, chủ nhà dùng" maxLength={500} />
          </div>
          {unit && datesOk ? (
            <div className="notice notice-warn small">
              <div>
                Sẽ chặn <strong>{unit.code}</strong> {nights} đêm, từ đêm {formatDateVi(start)} đến sáng {formatDateVi(end)} (ngày theo giờ Budapest).
                {unit.kind === "whole" ? " Các phòng lẻ thuộc nguyên căn này cũng không bán được." : " Nguyên căn chứa phòng này cũng không bán được."} Nếu khoảng này đã có booking, hệ
                thống sẽ từ chối và liệt kê booking đang chiếm.
              </div>
            </div>
          ) : null}
          {!datesOk && start && end ? <div className="form-error">Ngày mở lại phải sau ngày bắt đầu.</div> : null}
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function ReleaseBlockButton({ block }: { block: { id: string; unitCode: string; startDate: string; endDate: string; reason: string } }) {
  const [open, setOpen] = useState(false);
  const { run, busy, error, setError } = useAction();
  function close() {
    setOpen(false);
    setError(null);
  }
  return (
    <>
      <button type="button" className="btn btn-sm btn-danger" onClick={() => setOpen(true)}>
        Gỡ chặn
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Gỡ chặn tồn"
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Không
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                const res = await run(`/api/v1/inventory-blocks/${block.id}`, { method: "DELETE" });
                if (!res.error) setOpen(false);
              }}
            >
              {busy ? "Đang gỡ…" : "Gỡ chặn"}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          Gỡ chặn <strong>{block.unitCode}</strong> từ đêm {formatDateVi(block.startDate)} đến sáng {formatDateVi(block.endDate)} ({block.reason})? Phòng sẽ bán được trở lại trên hệ
          thống; kênh bán ngoài không tự cập nhật.
        </p>
        <ErrorText error={error} />
      </Dialog>
    </>
  );
}
