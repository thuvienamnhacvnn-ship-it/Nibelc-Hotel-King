"use client";

import { useState } from "react";
import { type ApiError, Dialog, ErrorText, callApi, useAction } from "@/components/client";
import { CHANGE_KIND_LABELS, PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, STAY_STATUS_LABELS } from "@/modules/booking/types";
import styles from "../bookings.module.css";

// ───────────────────────── Trạng thái lưu trú ─────────────────────────

/** Khớp STAY_TRANSITIONS trong service — server vẫn là nơi quyết định. */
const NEXT_STAY: Record<string, string[]> = {
  expected: ["checked_in", "no_show"],
  checked_in: ["checked_out"],
  no_show: ["expected"],
  unknown: ["checked_in", "checked_out", "no_show"],
  checked_out: [],
};
const STAY_ACTION_LABELS: Record<string, string> = {
  checked_in: "Khách đã nhận phòng",
  checked_out: "Khách đã trả phòng",
  no_show: "Khách không đến",
  expected: "Đưa về chưa đến",
};

export function StayStatusButtons({ bookingId, version, stayStatus }: { bookingId: string; version: number; stayStatus: string }) {
  const [target, setTarget] = useState<string | null>(null);
  const { run, busy, error, setError } = useAction();
  const options = NEXT_STAY[stayStatus] ?? [];
  if (!options.length) return <span className="small faint">Không còn bước chuyển trạng thái lưu trú.</span>;

  function close() {
    setTarget(null);
    setError(null);
  }
  async function submit() {
    const res = await run(`/api/v1/bookings/${bookingId}/stay-status`, { method: "POST", body: { status: target, expectedVersion: version } });
    if (!res.error) close();
  }

  return (
    <>
      <div className="row">
        {options.map((s) => (
          <button key={s} type="button" className={`btn btn-sm ${s === "no_show" ? "btn-danger" : ""}`} onClick={() => setTarget(s)}>
            {STAY_ACTION_LABELS[s]}
          </button>
        ))}
      </div>
      <Dialog
        open={target !== null}
        onClose={close}
        title="Xác nhận trạng thái lưu trú"
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Không
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? "Đang gửi…" : "Xác nhận"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div>
            Chuyển từ <strong>{STAY_STATUS_LABELS[stayStatus]}</strong> sang <strong>{target ? STAY_STATUS_LABELS[target] : ""}</strong>.
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Ghi nhận theo thời điểm hiện tại. Chỉ xác nhận khi đã biết chắc (khách/nhân viên báo) — giờ dự kiến không chứng minh khách đã đến hay đã đi.
            {target === "checked_out" ? " Phòng sẽ chuyển sang trạng thái cần dọn." : ""}
          </p>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}

// ───────────────────────── Sửa thông tin không ảnh hưởng tồn ─────────────────────────

export interface EditableBooking {
  id: string;
  version: number;
  eta_local: string | null;
  channel_note: string | null;
  ops_note: string | null;
  external_ref: string | null;
  payment_status: string;
  total_amount_minor: number | null;
  currency: string;
  guest_name: string | null;
  guest_phone: string | null;
  guest_email: string | null;
  guest_language: string | null;
}

function minorToInput(minor: number | null) {
  if (minor == null) return "";
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

export function EditDetailsForm({ booking, showGuest, showMoney }: { booking: EditableBooking; showGuest: boolean; showMoney: boolean }) {
  const initial = {
    etaLocal: booking.eta_local ?? "",
    channelNote: booking.channel_note ?? "",
    opsNote: booking.ops_note ?? "",
    externalRef: booking.external_ref ?? "",
    paymentStatus: booking.payment_status,
    totalAmount: minorToInput(booking.total_amount_minor),
    currency: booking.currency,
    fullName: booking.guest_name ?? "",
    phone: booking.guest_phone ?? "",
    email: booking.guest_email ?? "",
    language: booking.guest_language ?? "",
  };
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(initial);
  const { run, busy, error, setError } = useAction();
  const set = (k: keyof typeof initial) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  function openForm() {
    setV(initial);
    setError(null);
    setOpen(true);
  }

  async function submit() {
    const body: Record<string, unknown> = { expectedVersion: booking.version };
    if (v.etaLocal !== initial.etaLocal) body.etaLocal = v.etaLocal;
    if (v.channelNote !== initial.channelNote) body.channelNote = v.channelNote || null;
    if (v.opsNote !== initial.opsNote) body.opsNote = v.opsNote || null;
    if (v.externalRef !== initial.externalRef) body.externalRef = v.externalRef || null;
    if (v.paymentStatus !== initial.paymentStatus) body.paymentStatus = v.paymentStatus;
    if (showMoney && v.totalAmount !== initial.totalAmount) body.totalAmount = v.totalAmount.trim() || null;
    if (showMoney && v.currency !== initial.currency) body.currency = v.currency;
    if (showGuest) {
      const guest: Record<string, string | null> = {};
      if (v.fullName !== initial.fullName && v.fullName.trim()) guest.fullName = v.fullName.trim();
      if (v.phone !== initial.phone) guest.phone = v.phone.trim() || null;
      if (v.email !== initial.email) guest.email = v.email.trim() || null;
      if (v.language !== initial.language) guest.language = v.language.trim() || null;
      if (Object.keys(guest).length) body.guest = guest;
    }
    if (Object.keys(body).length === 1) {
      setError({ code: "no_change", message: "Chưa sửa trường nào.", status: 0 });
      return;
    }
    const res = await run(`/api/v1/bookings/${booking.id}`, { method: "PATCH", body });
    if (!res.error) setOpen(false);
  }

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={openForm}>
        Sửa thông tin
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Sửa thông tin booking"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
              Hủy bỏ
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? "Đang lưu…" : "Lưu"}
            </button>
          </>
        }
      >
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>
            Chỉ các trường không ảnh hưởng tồn phòng. Đổi ngày, phòng, số khách hoặc hủy phải tạo yêu cầu thay đổi. Nếu người khác vừa sửa booking, hệ thống từ chối lưu để không ghi đè.
          </p>
          <div className={styles.formGrid}>
            {showGuest ? (
              <>
                <Field label="Tên khách" id="ed-name">
                  <input id="ed-name" className="input" value={v.fullName} onChange={set("fullName")} maxLength={200} />
                </Field>
                <Field label="SĐT" id="ed-phone">
                  <input id="ed-phone" className="input" value={v.phone} onChange={set("phone")} maxLength={50} />
                </Field>
                <Field label="Email" id="ed-email">
                  <input id="ed-email" className="input" type="email" value={v.email} onChange={set("email")} maxLength={200} />
                </Field>
                <Field label="Ngôn ngữ" id="ed-lang">
                  <input id="ed-lang" className="input" value={v.language} onChange={set("language")} maxLength={20} />
                </Field>
              </>
            ) : null}
            <Field label="Mã đặt phòng" id="ed-ref">
              <input id="ed-ref" className="input" value={v.externalRef} onChange={set("externalRef")} maxLength={100} />
            </Field>
            <Field label="ETA (HH:MM)" id="ed-eta">
              <input id="ed-eta" className="input" type="time" value={v.etaLocal} onChange={set("etaLocal")} />
            </Field>
            <Field label="Thanh toán" id="ed-pay">
              <select id="ed-pay" className="select" value={v.paymentStatus} onChange={set("paymentStatus")}>
                {PAYMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PAYMENT_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            {showMoney ? (
              <>
                <Field label="Số tiền" id="ed-amount">
                  <input id="ed-amount" className="input" inputMode="decimal" placeholder="123.45" value={v.totalAmount} onChange={set("totalAmount")} />
                </Field>
                <Field label="Tiền tệ" id="ed-cur">
                  <input id="ed-cur" className="input" value={v.currency} onChange={set("currency")} maxLength={3} />
                </Field>
              </>
            ) : null}
          </div>
          <Field label="Ghi chú kênh" id="ed-cnote">
            <textarea id="ed-cnote" className="textarea" value={v.channelNote} onChange={set("channelNote")} maxLength={2000} />
          </Field>
          <Field label="Ghi chú vận hành" id="ed-onote">
            <textarea id="ed-onote" className="textarea" value={v.opsNote} onChange={set("opsNote")} maxLength={2000} />
          </Field>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

// ───────────────────────── Tạo yêu cầu thay đổi ─────────────────────────

interface AllocationLite {
  id: string;
  unit_id: string;
  unit_code: string;
  start_date: string;
  end_date: string;
  guests: number | null;
}
interface UnitLite {
  id: string;
  code: string;
  name: string;
  capacity: number;
  kind: string;
  active: boolean;
  property_code: string;
}
interface Check {
  ok: boolean;
  issues: { code: string; message: string }[];
}
interface Conflict {
  unit_code: string | null;
  booking_ref: string | null;
  start_date: string;
  end_date: string;
  block_reason: string | null;
}

type Kind = "dates" | "move_unit" | "guests" | "cancel" | "late_checkout" | "early_checkin";

export function CreateChangeRequestForm(props: {
  bookingId: string;
  checkInDate: string;
  checkOutDate: string;
  stayStatus: string;
  adults: number | null;
  children: number | null;
  allocations: AllocationLite[];
  units: UnitLite[];
  minCapacity: number | null;
  propertyTimes: { checkInFrom: string; checkOutAt: string };
  rules: { earliestEarlyCheckIn: string; latestLateCheckOut: string };
  canApprove: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("dates");
  const [checkIn, setCheckIn] = useState(props.checkInDate);
  const [checkOut, setCheckOut] = useState(props.checkOutDate);
  const [allocationId, setAllocationId] = useState(props.allocations[0]?.id ?? "");
  const [toUnitId, setToUnitId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [adults, setAdults] = useState(String(props.adults ?? 1));
  const [children, setChildren] = useState(String(props.children ?? 0));
  const [reason, setReason] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [applyNow, setApplyNow] = useState(false);
  const [preview, setPreview] = useState<{ issues: string[]; conflicts: Conflict[] } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<{ applied: boolean; check: Check } | null>(null);
  const { run, busy, error, setError } = useAction();

  const alloc = props.allocations.find((a) => a.id === allocationId);
  const midStayMove = props.allocations.some((a) => a.start_date !== props.checkInDate || a.end_date !== props.checkOutDate);

  function reset() {
    setPreview(null);
    setPreviewError(null);
    setOutcome(null);
    setError(null);
  }

  function change(): Record<string, unknown> {
    switch (kind) {
      case "dates":
        return { kind, checkInDate: checkIn, checkOutDate: checkOut };
      case "move_unit":
        return { kind, allocationId, toUnitId, effectiveDate: effectiveDate || null };
      case "guests":
        return { kind, adults: Number(adults), children: Number(children) };
      case "cancel":
        return { kind, reason: reason.trim() };
      default:
        return { kind, time };
    }
  }

  /** Xem trước: kiểm chỗ trống (chỉ đọc) + quy tắc đơn giản. Kiểm tra chính thức chạy ở server khi gửi và khi áp dụng. */
  async function runPreview() {
    reset();
    setPreviewBusy(true);
    const issues: string[] = [];
    const conflicts: Conflict[] = [];
    const avail = async (unitId: string, start: string, end: string) => {
      const q = new URLSearchParams({ unitId, start, end, excludeBookingId: props.bookingId });
      const res = await callApi<{ conflicts: Conflict[]; unit: { active: boolean; capacity: number } }>(`/api/v1/availability?${q}`);
      if (res.error) {
        setPreviewError(res.error);
        return null;
      }
      conflicts.push(...(res.data?.conflicts ?? []));
      return res.data ?? null;
    };
    if (kind === "dates") {
      if (!checkIn || !checkOut || checkOut <= checkIn) issues.push("Ngày trả phải sau ngày nhận.");
      else {
        if (midStayMove) issues.push("Booking có đổi phòng giữa kỳ — đổi ngày từng đoạn bằng thao tác đổi phòng.");
        if (props.stayStatus === "checked_in" && checkIn !== props.checkInDate) issues.push("Khách đã nhận phòng — không đổi được ngày nhận.");
        for (const a of props.allocations) await avail(a.unit_id, checkIn, checkOut);
      }
    } else if (kind === "move_unit") {
      if (!alloc || !toUnitId) issues.push("Chọn phân bổ hiện tại và phòng mới.");
      else {
        const eff = effectiveDate || alloc.start_date;
        if (eff < alloc.start_date || eff >= alloc.end_date) issues.push("Ngày chuyển phải nằm trong đoạn đang ở.");
        if (toUnitId === alloc.unit_id) issues.push("Phòng mới trùng phòng hiện tại.");
        const data = await avail(toUnitId, eff, alloc.end_date);
        if (data && !data.unit.active) issues.push("Phòng mới đang ngừng hoạt động.");
        if (data && alloc.guests != null && alloc.guests > data.unit.capacity) issues.push(`Phòng mới chứa tối đa ${data.unit.capacity} khách.`);
      }
    } else if (kind === "guests") {
      const total = Number(adults) + Number(children);
      if (props.minCapacity != null && total > props.minCapacity) issues.push(`Tổng ${total} khách vượt sức chứa ${props.minCapacity}.`);
    } else if (kind === "cancel") {
      if (reason.trim().length < 3) issues.push("Cần lý do hủy (ít nhất 3 ký tự).");
      if (props.stayStatus === "checked_in") issues.push("Khách đang ở — dùng đổi ngày trả phòng thay vì hủy.");
    } else if (kind === "late_checkout") {
      if (!time) issues.push("Chọn giờ trả.");
      else {
        if (time <= props.propertyTimes.checkOutAt) issues.push(`Giờ trả chuẩn là ${props.propertyTimes.checkOutAt}.`);
        if (time > props.rules.latestLateCheckOut) issues.push(`Trả muộn tối đa ${props.rules.latestLateCheckOut}.`);
      }
    } else if (kind === "early_checkin") {
      if (!time) issues.push("Chọn giờ nhận.");
      else {
        if (time >= props.propertyTimes.checkInFrom) issues.push(`Giờ nhận chuẩn là ${props.propertyTimes.checkInFrom}.`);
        if (time < props.rules.earliestEarlyCheckIn) issues.push(`Nhận sớm từ ${props.rules.earliestEarlyCheckIn}.`);
      }
    }
    setPreview({ issues, conflicts });
    setPreviewBusy(false);
  }

  async function submit() {
    setOutcome(null);
    const res = await run<{ applied: boolean; check: Check }>(`/api/v1/bookings/${props.bookingId}/change-requests`, {
      method: "POST",
      body: { change: change(), note: note.trim() || undefined, applyNow: props.canApprove && applyNow },
    });
    if (res.data) setOutcome({ applied: res.data.applied, check: res.data.check });
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Tạo yêu cầu thay đổi
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Yêu cầu thay đổi booking"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
              Đóng
            </button>
            <button type="button" className="btn" onClick={runPreview} disabled={busy || previewBusy}>
              {previewBusy ? "Đang kiểm…" : "Xem trước kiểm tra"}
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !!outcome}>
              {busy ? "Đang gửi…" : props.canApprove && applyNow ? "Gửi và áp dụng ngay" : "Gửi yêu cầu"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="field">
            <label htmlFor="cr-kind">Loại thay đổi</label>
            <select
              id="cr-kind"
              className="select"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as Kind);
                reset();
              }}
            >
              {(["dates", "move_unit", "guests", "cancel", "late_checkout", "early_checkin"] as Kind[]).map((k) => (
                <option key={k} value={k} disabled={k === "move_unit" && props.allocations.length === 0}>
                  {CHANGE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          {kind === "dates" ? (
            <div className={styles.formGrid}>
              <Field label="Ngày nhận mới" id="cr-in">
                <input id="cr-in" className="input" type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
              </Field>
              <Field label="Ngày trả mới" id="cr-out">
                <input id="cr-out" className="input" type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
              </Field>
            </div>
          ) : null}

          {kind === "move_unit" ? (
            <div className={styles.formGrid}>
              <Field label="Phân bổ hiện tại" id="cr-alloc">
                <select id="cr-alloc" className="select" value={allocationId} onChange={(e) => setAllocationId(e.target.value)}>
                  {props.allocations.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.unit_code} · {a.start_date} → {a.end_date}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Chuyển sang" id="cr-to">
                <select id="cr-to" className="select" value={toUnitId} onChange={(e) => setToUnitId(e.target.value)}>
                  <option value="">— Chọn phòng —</option>
                  {props.units.map((u) => (
                    <option key={u.id} value={u.id} disabled={!u.active}>
                      {u.property_code} · {u.code} — {u.name} (tối đa {u.capacity}){u.active ? "" : " · ngừng hoạt động"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Từ ngày (trống = cả đoạn)" id="cr-eff">
                <input
                  id="cr-eff"
                  className="input"
                  type="date"
                  value={effectiveDate}
                  min={alloc?.start_date}
                  max={alloc?.end_date}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                />
              </Field>
            </div>
          ) : null}

          {kind === "guests" ? (
            <div className={styles.formGrid}>
              <Field label="Người lớn" id="cr-ad">
                <input id="cr-ad" className="input" type="number" min={0} max={50} value={adults} onChange={(e) => setAdults(e.target.value)} />
              </Field>
              <Field label="Trẻ em" id="cr-ch">
                <input id="cr-ch" className="input" type="number" min={0} max={50} value={children} onChange={(e) => setChildren(e.target.value)} />
              </Field>
              <div className="hint">Sức chứa nhỏ nhất theo đêm của phòng đang giữ: {props.minCapacity ?? "chưa rõ"}</div>
            </div>
          ) : null}

          {kind === "cancel" ? (
            <Field label="Lý do hủy (bắt buộc)" id="cr-reason">
              <textarea id="cr-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </Field>
          ) : null}

          {kind === "late_checkout" || kind === "early_checkin" ? (
            <Field label={kind === "late_checkout" ? `Giờ trả (chuẩn ${props.propertyTimes.checkOutAt}, tối đa ${props.rules.latestLateCheckOut})` : `Giờ nhận (chuẩn ${props.propertyTimes.checkInFrom}, sớm nhất ${props.rules.earliestEarlyCheckIn})`} id="cr-time">
              <input id="cr-time" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          ) : null}

          <Field label="Ghi chú (nguồn yêu cầu, nội dung khách nhắn…)" id="cr-note">
            <textarea id="cr-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>

          {props.canApprove ? (
            <label className="row small">
              <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} /> Áp dụng ngay nếu kiểm tra đạt (bạn có quyền duyệt)
            </label>
          ) : (
            <div className="hint">Yêu cầu sẽ chờ người có quyền duyệt áp dụng.</div>
          )}

          {previewError ? <ErrorText error={previewError} /> : null}
          {preview ? (
            <div className={`notice ${preview.issues.length || preview.conflicts.length ? "notice-warn" : "notice-info"}`}>
              <div>
                <div className="strong">{preview.issues.length || preview.conflicts.length ? "Xem trước: có vấn đề" : "Xem trước: chưa thấy vấn đề"}</div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {preview.issues.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                  {preview.conflicts.map((c, i) => (
                    <li key={`c${i}`}>
                      {c.block_reason ? `Chặn tồn: ${c.block_reason}` : `Trùng booking ${c.booking_ref ?? "(không mã)"} · ${c.unit_code ?? ""}`} — {c.start_date} → {c.end_date}
                    </li>
                  ))}
                </ul>
                <div className="small">Kiểm tra chính thức (gồm khách nhận/trả cùng ngày) chạy khi gửi và lại lần nữa khi áp dụng.</div>
              </div>
            </div>
          ) : null}

          <ErrorText error={error} />
          {outcome ? (
            <div className={`notice ${outcome.applied ? "notice-info" : outcome.check.ok ? "notice-info" : "notice-warn"}`}>
              <div>
                <div className="strong">
                  {outcome.applied ? "Đã tạo và áp dụng thay đổi." : outcome.check.ok ? "Đã tạo yêu cầu — kiểm tra đạt, đang chờ duyệt." : "Đã tạo yêu cầu — kiểm tra KHÔNG đạt, chưa áp dụng."}
                </div>
                {outcome.check.issues.length ? (
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {outcome.check.issues.map((m, i) => (
                      <li key={i}>{m.message}</li>
                    ))}
                  </ul>
                ) : null}
                {applyNow && !outcome.applied ? <div className="small">Không áp dụng ngay vì kiểm tra chưa đạt. Yêu cầu vẫn ở hàng chờ duyệt.</div> : null}
              </div>
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
