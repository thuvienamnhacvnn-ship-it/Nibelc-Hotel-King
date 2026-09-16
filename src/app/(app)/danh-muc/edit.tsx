"use client";

import { useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";
import { DATA_STATUS_LABELS, LISTING_STATUS_LABELS } from "@/modules/catalog/labels";

type When = string | Date;
const iso = (v: When) => new Date(v).toISOString();

function DataFields({ status, setStatus, note, setNote, idPrefix }: { status: string; setStatus: (v: string) => void; note: string; setNote: (v: string) => void; idPrefix: string }) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-ds`}>Trạng thái dữ liệu</label>
        <select id={`${idPrefix}-ds`} className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(DATA_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-note`}>Ghi chú dữ liệu</label>
        <textarea id={`${idPrefix}-note`} className="textarea" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Nguồn xác nhận, điểm còn lệch…" />
      </div>
    </>
  );
}

function useEditDialog() {
  const [open, setOpen] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const action = useAction();
  const close = () => {
    setOpen(false);
    setWarning(null);
    action.setError(null);
  };
  return { open, setOpen, warning, setWarning, close, ...action };
}

function Footer({ busy, close, save, disabled, done }: { busy: boolean; close: () => void; save: () => void; disabled: boolean; done: boolean }) {
  if (done) {
    return (
      <button type="button" className="btn btn-primary" onClick={close}>
        Đóng
      </button>
    );
  }
  return (
    <>
      <button type="button" className="btn" onClick={close} disabled={busy}>
        Huỷ
      </button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={busy || disabled}>
        {busy ? "Đang lưu…" : "Lưu thay đổi"}
      </button>
    </>
  );
}

export function EditUnitButton({
  unit,
}: {
  unit: { id: string; code: string; name: string; capacity: number; active: boolean; clean_minutes: number | null; data_status: string; data_note: string | null; updated_at: When };
}) {
  const d = useEditDialog();
  const [capacity, setCapacity] = useState(String(unit.capacity));
  const [active, setActive] = useState(unit.active);
  const [clean, setClean] = useState(unit.clean_minutes ? String(unit.clean_minutes) : "");
  const [status, setStatus] = useState(unit.data_status);
  const [note, setNote] = useState(unit.data_note ?? "");

  const body: Record<string, unknown> = {};
  if (Number(capacity) !== unit.capacity) body.capacity = Number(capacity);
  if (active !== unit.active) body.active = active;
  if ((clean ? Number(clean) : null) !== unit.clean_minutes) body.cleanMinutes = clean ? Number(clean) : null;
  if (status !== unit.data_status) body.dataStatus = status;
  if ((note.trim() || null) !== unit.data_note) body.dataNote = note.trim() || null;
  const dirty = Object.keys(body).length > 0;

  async function save() {
    const res = await d.run<{ warning: string | null }>(`/api/v1/catalog/units/${unit.id}`, { method: "PATCH", body: { ...body, expectedUpdatedAt: iso(unit.updated_at) } });
    if (res.error) return;
    if (res.data?.warning) d.setWarning(res.data.warning);
    else d.close();
  }

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => d.setOpen(true)}>
        Sửa
      </button>
      <Dialog open={d.open} onClose={d.close} title={`Sửa sản phẩm ${unit.code}`} footer={<Footer busy={d.busy} close={d.close} save={save} disabled={!dirty} done={!!d.warning} />}>
        <div className="stack">
          <div className="small muted">{unit.name}</div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor={`u-${unit.id}-cap`}>Sức chứa (khách)</label>
              <input id={`u-${unit.id}-cap`} type="number" min={1} max={50} className="input" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`u-${unit.id}-clean`}>Thời lượng dọn (phút)</label>
              <input id={`u-${unit.id}-clean`} type="number" min={10} max={600} className="input" value={clean} placeholder="Theo mặc định của nhà" onChange={(e) => setClean(e.target.value)} />
            </div>
          </div>
          <label className="row">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Đang hoạt động (nhận booking mới)
          </label>
          <DataFields idPrefix={`u-${unit.id}`} status={status} setStatus={setStatus} note={note} setNote={setNote} />
          <div className="hint">Giảm sức chứa bị từ chối nếu còn booking sắp tới đông khách hơn. Quan hệ phòng vật lý không sửa ở đây.</div>
          {d.warning ? <div className="notice notice-warn small">Đã lưu. {d.warning}</div> : null}
          <ErrorText error={d.error} />
        </div>
      </Dialog>
    </>
  );
}

export function EditListingButton({
  listing,
}: {
  listing: { id: string; unit_code: string; channel: string; listing_name: string | null; status: string; data_status: string; data_note: string | null; updated_at: When };
}) {
  const d = useEditDialog();
  const [lstatus, setLstatus] = useState(listing.status);
  const [status, setStatus] = useState(listing.data_status);
  const [note, setNote] = useState(listing.data_note ?? "");
  const body: Record<string, unknown> = {};
  if (lstatus !== listing.status) body.status = lstatus;
  if (status !== listing.data_status) body.dataStatus = status;
  if ((note.trim() || null) !== listing.data_note) body.dataNote = note.trim() || null;
  const dirty = Object.keys(body).length > 0;

  async function save() {
    const res = await d.run(`/api/v1/catalog/listings/${listing.id}`, { method: "PATCH", body: { ...body, expectedUpdatedAt: iso(listing.updated_at) } });
    if (!res.error) d.close();
  }

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => d.setOpen(true)}>
        Sửa
      </button>
      <Dialog open={d.open} onClose={d.close} title={`Listing ${listing.unit_code} · ${listing.channel}`} footer={<Footer busy={d.busy} close={d.close} save={save} disabled={!dirty} done={false} />}>
        <div className="stack">
          <div className="small muted">{listing.listing_name ?? "(chưa có tên listing)"}</div>
          <div className="field">
            <label htmlFor={`l-${listing.id}-st`}>Trạng thái trên kênh này</label>
            <select id={`l-${listing.id}-st`} className="select" value={lstatus} onChange={(e) => setLstatus(e.target.value)}>
              {Object.entries(LISTING_STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <div className="hint">Chỉ ghi nhận trạng thái của listing trên kênh này; không khoá sản phẩm và không đổi tồn trên các kênh khác.</div>
          </div>
          <DataFields idPrefix={`l-${listing.id}`} status={status} setStatus={setStatus} note={note} setNote={setNote} />
          <ErrorText error={d.error} />
        </div>
      </Dialog>
    </>
  );
}

export function EditPropertyButton({
  property,
}: {
  property: { id: string; code: string; name: string; default_clean_minutes: number; data_status: string; data_note: string | null; updated_at: When };
}) {
  const d = useEditDialog();
  const [clean, setClean] = useState(String(property.default_clean_minutes));
  const [status, setStatus] = useState(property.data_status);
  const [note, setNote] = useState(property.data_note ?? "");
  const body: Record<string, unknown> = {};
  if (Number(clean) !== property.default_clean_minutes) body.defaultCleanMinutes = Number(clean);
  if (status !== property.data_status) body.dataStatus = status;
  if ((note.trim() || null) !== property.data_note) body.dataNote = note.trim() || null;
  const dirty = Object.keys(body).length > 0;

  async function save() {
    const res = await d.run(`/api/v1/catalog/properties/${property.id}`, { method: "PATCH", body: { ...body, expectedUpdatedAt: iso(property.updated_at) } });
    if (!res.error) d.close();
  }

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => d.setOpen(true)}>
        Sửa
      </button>
      <Dialog open={d.open} onClose={d.close} title={`Sửa nhà ${property.code}`} footer={<Footer busy={d.busy} close={d.close} save={save} disabled={!dirty} done={false} />}>
        <div className="stack">
          <div className="small muted">{property.name}</div>
          <div className="field">
            <label htmlFor={`p-${property.id}-clean`}>Thời lượng dọn mặc định (phút)</label>
            <input id={`p-${property.id}-clean`} type="number" min={10} max={600} className="input" value={clean} onChange={(e) => setClean(e.target.value)} />
          </div>
          <DataFields idPrefix={`p-${property.id}`} status={status} setStatus={setStatus} note={note} setNote={setNote} />
          <ErrorText error={d.error} />
        </div>
      </Dialog>
    </>
  );
}
