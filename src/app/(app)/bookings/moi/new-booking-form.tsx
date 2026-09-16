"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { type ApiError, ErrorText, callApi, useAction } from "@/components/client";
import { CHANNEL_LABELS, PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, SOURCE_CHANNELS } from "@/modules/booking/types";
import styles from "../bookings.module.css";

interface UnitLite {
  id: string;
  code: string;
  name: string;
  kind: string;
  capacity: number;
  active: boolean;
  propertyId: string;
  propertyCode: string;
  propertyName: string;
}

interface Conflict {
  unit_code: string | null;
  booking_ref: string | null;
  start_date: string;
  end_date: string;
  block_reason: string | null;
}

const KIND_LABELS: Record<string, string> = { whole: "Nguyên căn", room: "Phòng lẻ", studio: "Studio" };

function addDay(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function NewBookingForm({ units, showMoney, today }: { units: UnitLite[]; showMoney: boolean; today: string }) {
  const router = useRouter();
  const [v, setV] = useState({
    sourceChannel: "direct",
    sourceAccount: "",
    externalRef: "",
    fullName: "",
    phone: "",
    email: "",
    language: "",
    checkInDate: today,
    checkOutDate: addDay(today),
    adults: "2",
    children: "0",
    etaLocal: "",
    totalAmount: "",
    paymentStatus: "unknown",
    channelNote: "",
    opsNote: "",
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [availability, setAvailability] = useState<Record<string, { available: boolean; conflicts: Conflict[] }> | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<ApiError | null>(null);
  const { run, busy, error, setError } = useAction();
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    setV((s) => ({ ...s, [k]: e.target.value }));
    if (k === "checkInDate" || k === "checkOutDate") setAvailability(null);
  };

  const properties = [...new Map(units.map((u) => [u.propertyId, { id: u.propertyId, code: u.propertyCode, name: u.propertyName }])).values()];
  const selectedUnits = units.filter((u) => selected.includes(u.id));
  const totalGuests = Number(v.adults || 0) + Number(v.children || 0);
  const selectedCapacity = selectedUnits.reduce((n, u) => n + u.capacity, 0);

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    setAvailability(null);
  }

  async function checkAll(): Promise<boolean> {
    setCheckError(null);
    if (!selected.length || !v.checkInDate || !v.checkOutDate || v.checkOutDate <= v.checkInDate) {
      setCheckError({ code: "invalid_input", message: "Chọn ít nhất một căn/phòng và ngày trả sau ngày nhận.", status: 422 });
      return false;
    }
    setChecking(true);
    const result: Record<string, { available: boolean; conflicts: Conflict[] }> = {};
    for (const unitId of selected) {
      const q = new URLSearchParams({ unitId, start: v.checkInDate, end: v.checkOutDate });
      const res = await callApi<{ available: boolean; conflicts: Conflict[] }>(`/api/v1/availability?${q}`);
      if (res.error) {
        setChecking(false);
        setCheckError(res.error);
        return false;
      }
      result[unitId] = { available: !!res.data?.available, conflicts: res.data?.conflicts ?? [] };
    }
    setAvailability(result);
    setChecking(false);
    return Object.values(result).every((r) => r.available);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Kiểm chỗ trống trước để người nhập thấy xung đột; server vẫn kiểm lại và khoá khi lưu.
    const ok = await checkAll();
    if (!ok) return;
    const body = {
      sourceChannel: v.sourceChannel,
      sourceAccount: v.sourceAccount.trim(),
      externalRef: v.externalRef.trim() || null,
      guest: { fullName: v.fullName.trim(), phone: v.phone.trim() || null, email: v.email.trim() || null, language: v.language.trim() || null },
      checkInDate: v.checkInDate,
      checkOutDate: v.checkOutDate,
      allocations: selected.map((unitId) => ({ unitId })),
      adults: v.adults === "" ? null : Number(v.adults),
      children: v.children === "" ? null : Number(v.children),
      etaLocal: v.etaLocal || null,
      ...(showMoney && v.totalAmount.trim() ? { totalAmount: v.totalAmount.trim() } : {}),
      paymentStatus: v.paymentStatus,
      channelNote: v.channelNote.trim() || null,
      opsNote: v.opsNote.trim() || null,
    };
    const res = await run<{ id: string }>("/api/v1/bookings", { method: "POST", body }, { refresh: false });
    if (res.data?.id) router.push(`/bookings/${res.data.id}`);
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="card card-pad stack">
        <h2 style={{ margin: 0 }}>Nguồn và khách</h2>
        <div className={styles.formGrid}>
          <div className="field">
            <label htmlFor="nb-channel">Kênh</label>
            <select id="nb-channel" className="select" value={v.sourceChannel} onChange={set("sourceChannel")}>
              {SOURCE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="nb-account">Tài khoản/property trên kênh</label>
            <input id="nb-account" className="input" value={v.sourceAccount} onChange={set("sourceAccount")} maxLength={100} />
          </div>
          <div className="field">
            <label htmlFor="nb-ref">Mã đặt phòng</label>
            <input id="nb-ref" className="input" value={v.externalRef} onChange={set("externalRef")} maxLength={100} />
            <span className="hint">Kênh + tài khoản + mã phải duy nhất.</span>
          </div>
          <div className="field">
            <label htmlFor="nb-name">Tên khách *</label>
            <input id="nb-name" className="input" required value={v.fullName} onChange={set("fullName")} maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="nb-phone">SĐT</label>
            <input id="nb-phone" className="input" value={v.phone} onChange={set("phone")} maxLength={50} />
          </div>
          <div className="field">
            <label htmlFor="nb-email">Email</label>
            <input id="nb-email" className="input" type="email" value={v.email} onChange={set("email")} maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="nb-lang">Ngôn ngữ</label>
            <input id="nb-lang" className="input" value={v.language} onChange={set("language")} maxLength={20} placeholder="vi, en, de…" />
          </div>
        </div>
      </div>

      <div className="card card-pad stack">
        <h2 style={{ margin: 0 }}>Ngày và số khách</h2>
        <div className={styles.formGrid}>
          <div className="field">
            <label htmlFor="nb-in">Ngày nhận *</label>
            <input id="nb-in" className="input" type="date" required value={v.checkInDate} onChange={set("checkInDate")} />
          </div>
          <div className="field">
            <label htmlFor="nb-out">Ngày trả *</label>
            <input id="nb-out" className="input" type="date" required value={v.checkOutDate} onChange={set("checkOutDate")} />
          </div>
          <div className="field">
            <label htmlFor="nb-adults">Người lớn</label>
            <input id="nb-adults" className="input" type="number" min={0} max={50} value={v.adults} onChange={set("adults")} />
          </div>
          <div className="field">
            <label htmlFor="nb-children">Trẻ em</label>
            <input id="nb-children" className="input" type="number" min={0} max={50} value={v.children} onChange={set("children")} />
          </div>
          <div className="field">
            <label htmlFor="nb-eta">ETA (giờ Budapest)</label>
            <input id="nb-eta" className="input" type="time" value={v.etaLocal} onChange={set("etaLocal")} />
          </div>
        </div>
        <div className="hint">Ngày theo giờ Budapest; số đêm = ngày trả − ngày nhận.</div>
      </div>

      <div className="card card-pad stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>Căn/phòng</h2>
          <span className="spacer" />
          <span className="small muted">
            Đã chọn {selectedUnits.length} · sức chứa {selectedCapacity} · khách {totalGuests}
          </span>
          <button type="button" className="btn btn-sm" onClick={checkAll} disabled={checking}>
            {checking ? "Đang kiểm…" : "Kiểm tra chỗ trống"}
          </button>
        </div>
        {selectedUnits.length && totalGuests > selectedCapacity ? <div className="form-error">Tổng khách vượt sức chứa của các phòng đã chọn.</div> : null}
        <p className="small muted" style={{ margin: 0 }}>
          Nguyên căn chiếm mọi phòng trong nhà: đặt nguyên căn sẽ trùng với phòng lẻ cùng nhà và ngược lại.
        </p>
        {properties.map((p) => (
          <div key={p.id} className="stack" style={{ gap: 6 }}>
            <div className="strong">
              {p.code} — {p.name}
            </div>
            <div className={styles.unitGrid}>
              {units
                .filter((u) => u.propertyId === p.id)
                .map((u) => {
                  const a = availability?.[u.id];
                  return (
                    <label key={u.id} className={styles.unitOption} style={a && !a.available ? { borderColor: "var(--danger)" } : undefined}>
                      <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} disabled={!u.active} />
                      <span>
                        <span className="strong">{u.code}</span> {u.name}
                        <br />
                        <span className="faint">
                          {KIND_LABELS[u.kind] ?? u.kind} · tối đa {u.capacity}
                          {u.active ? "" : " · ngừng hoạt động"}
                        </span>
                        {a ? (
                          a.available ? (
                            <span style={{ color: "var(--ok)" }}> · còn trống</span>
                          ) : (
                            <span style={{ color: "var(--danger)", display: "block" }}>
                              {a.conflicts.length
                                ? a.conflicts.map((c, i) => (
                                    <span key={i} style={{ display: "block" }}>
                                      {c.block_reason ? `Chặn: ${c.block_reason}` : `Trùng ${c.booking_ref ?? "(không mã)"} ${c.unit_code ?? ""}`} {c.start_date}→{c.end_date}
                                    </span>
                                  ))
                                : "Không nhận được"}
                            </span>
                          )
                        ) : null}
                      </span>
                    </label>
                  );
                })}
            </div>
          </div>
        ))}
        <ErrorText error={checkError} />
      </div>

      <div className="card card-pad stack">
        <h2 style={{ margin: 0 }}>Thanh toán và ghi chú</h2>
        <div className={styles.formGrid}>
          <div className="field">
            <label htmlFor="nb-pay">Thanh toán</label>
            <select id="nb-pay" className="select" value={v.paymentStatus} onChange={set("paymentStatus")}>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PAYMENT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          {showMoney ? (
            <div className="field">
              <label htmlFor="nb-amount">Số tiền (EUR)</label>
              <input id="nb-amount" className="input" inputMode="decimal" placeholder="123.45" value={v.totalAmount} onChange={set("totalAmount")} />
            </div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="nb-cnote">Ghi chú kênh</label>
          <textarea id="nb-cnote" className="textarea" value={v.channelNote} onChange={set("channelNote")} maxLength={2000} />
        </div>
        <div className="field">
          <label htmlFor="nb-onote">Ghi chú vận hành</label>
          <textarea id="nb-onote" className="textarea" value={v.opsNote} onChange={set("opsNote")} maxLength={2000} />
          <span className="hint">Không ghi SĐT/email khách vào ghi chú — mọi người xem được booking đều đọc được. Liên hệ khách nhập ở ô SĐT/Email phía trên.</span>
        </div>
      </div>

      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || checking}>
          {busy ? "Đang lưu…" : checking ? "Đang kiểm chỗ trống…" : "Kiểm tra và lưu booking"}
        </button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}
