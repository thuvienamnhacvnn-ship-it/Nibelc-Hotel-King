"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorText, useAction } from "@/components/client";

interface SheetInfo {
  name: string;
  hasBookingHeader: boolean;
  headerRow: number | null;
  dataRows: number;
  suggestedRole: "source" | "house" | "cancel" | "other";
}

export interface AccountChoice {
  id: string;
  /** Nhãn đã kèm tên kênh, dựng ở server để client không phải nhập bảng nhãn. */
  text: string;
}

const MAX_MB = 15;

function roleText(sheet: SheetInfo, source: string) {
  if (!sheet.hasBookingHeader) return "Không có bảng booking — bỏ qua";
  if (sheet.suggestedRole === "cancel") return "Sheet Hủy — mọi dòng vào hàng kiểm tra, không chọn làm nguồn";
  if (sheet.name === source) return "Sheet nguồn — dòng sẽ vào lô";
  return "Sheet nhà — chỉ đối chiếu, không cộng";
}

/** Chọn file → đọc danh sách sheet → chọn sheet nguồn + tài khoản OTA → xem trước (lưu lô, chưa tạo booking). */
export function UploadPanel({ accounts, accountRequired }: { accounts: AccountChoice[]; accountRequired: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<SheetInfo[] | null>(null);
  const [source, setSource] = useState("TH");
  // Chỉ có một tài khoản ⇒ chọn sẵn; nhiều tài khoản ⇒ để trống, bắt người nhập chọn (server cũng từ chối nếu thiếu).
  const [accountId, setAccountId] = useState(accounts.length === 1 ? accounts[0].id : "");
  const { run, busy, error, setError } = useAction();

  async function pick(f: File | null) {
    setFile(f);
    setSheets(null);
    setError(null);
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) {
      setError({ code: "too_large", message: `File lớn hơn ${MAX_MB} MB.`, status: 422 });
      return;
    }
    const form = new FormData();
    form.append("file", f);
    const res = await run<{ sheets: SheetInfo[] }>("/api/v1/imports/inspect", { body: form }, { refresh: false });
    if (!res.data) return;
    setSheets(res.data.sheets);
    const withHeader = res.data.sheets.filter((s) => s.hasBookingHeader && s.suggestedRole !== "cancel");
    setSource(withHeader.find((s) => s.name.trim().toUpperCase() === "TH")?.name ?? withHeader[0]?.name ?? "TH");
  }

  async function preview() {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("sheet", source);
    if (accountId) form.append("connectorId", accountId);
    const res = await run<{ batchId: string }>("/api/v1/imports", { body: form }, { refresh: false });
    if (res.data) router.push(`/nhap-excel/${res.data.batchId}`);
  }

  const missingAccount = accountRequired && !accountId;

  // Sheet Hủy không được làm sheet nguồn (server cũng từ chối).
  const bookingSheets = sheets?.filter((s) => s.hasBookingHeader && s.suggestedRole !== "cancel") ?? [];
  const appliedBatch = error?.code === "file_already_applied" ? (error.details as { batchId?: string } | undefined)?.batchId : undefined;

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="import-file">File Excel lịch đặt phòng (.xlsx, tối đa {MAX_MB} MB)</label>
        <input id="import-file" className="input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <span className="hint">File chỉ được đọc để xem trước; chưa tạo booking nào cho tới khi bấm áp dụng ở bước sau.</span>
      </div>

      {accounts.length ? (
        <div className="field">
          <label htmlFor="import-account">Tài khoản nguồn{accountRequired ? " (bắt buộc)" : ""}</label>
          <select id="import-account" className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={busy}>
            <option value="">{accountRequired ? "— Chọn tài khoản —" : "Không ghi tài khoản"}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.text}
              </option>
            ))}
          </select>
          <span className="hint">
            Hai tài khoản OTA khác nhau có thể trùng mã đặt phòng. Mã đặt phòng chỉ được coi là đã nhập khi trùng <strong>cùng tài khoản</strong>, nên chọn sai tài khoản sẽ tạo đơn trùng hoặc
            bỏ sót đơn.
          </span>
          {missingAccount ? <div className="form-error">Tổ chức có nhiều tài khoản trên cùng một kênh — phải chọn tài khoản nguồn trước khi xem trước.</div> : null}
        </div>
      ) : (
        <p className="hint">Chưa khai tài khoản kênh nào — lô nhập sẽ không ghi tài khoản nguồn (như dữ liệu cũ).</p>
      )}

      {sheets ? (
        <>
          {bookingSheets.length === 0 ? (
            <div className="form-error">Không sheet nào có dòng tiêu đề booking (MÃ ĐẶT PHÒNG, THỜI GIAN NHẬN PHÒNG, CĂN HỘ).</div>
          ) : (
            <div className="field">
              <label htmlFor="import-sheet">Sheet nguồn</label>
              <select id="import-sheet" className="select" value={source} onChange={(e) => setSource(e.target.value)} disabled={busy}>
                {bookingSheets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.dataRows} dòng)
                  </option>
                ))}
              </select>
              <span className="hint">Mặc định TH. Các sheet theo nhà chỉ dùng để đối chiếu với sheet nguồn, không cộng thêm booking.</span>
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sheet</th>
                  <th>Tiêu đề ở dòng</th>
                  <th>Số dòng dữ liệu</th>
                  <th>Cách dùng</th>
                </tr>
              </thead>
              <tbody>
                {sheets.map((s) => (
                  <tr key={s.name}>
                    <td className="strong">{s.name}</td>
                    <td>{s.headerRow ?? "—"}</td>
                    <td>{s.hasBookingHeader ? s.dataRows : "—"}</td>
                    <td className="small">{roleText(s, source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {bookingSheets.length ? (
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={preview} disabled={busy || !file || missingAccount}>
                {busy ? "Đang phân tích…" : "Xem trước"}
              </button>
            </div>
          ) : null}
        </>
      ) : busy ? (
        <div className="small muted">Đang đọc file…</div>
      ) : null}

      <ErrorText error={error} />
      {appliedBatch ? (
        <div className="small">
          <Link href={`/nhap-excel/${appliedBatch}`}>Mở lô đã áp dụng file này</Link>
        </div>
      ) : null}
    </div>
  );
}
