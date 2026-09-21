"use client";

import { useState } from "react";
import { ErrorText, useAction } from "@/components/client";

const MIN = 10;

/** Tự đổi mật khẩu: phải nhập mật khẩu hiện tại. Phiên đang dùng được giữ, các phiên khác bị huỷ. */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const { run, busy, error } = useAction();
  const mismatch = again.length > 0 && next !== again;
  const ready = current.length > 0 && next.length >= MIN && next === again && next !== current;

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await run<{ sessionsRevoked: number }>("/api/v1/auth/change-password", { body: { currentPassword: current, newPassword: next } });
        if (!res.error) {
          setCurrent("");
          setNext("");
          setAgain("");
          setDone(res.data?.sessionsRevoked ?? 0);
        }
      }}
    >
      {done !== null ? (
        <div className="notice notice-info">
          Đã đổi mật khẩu. {done > 0 ? `${done} phiên khác (máy/điện thoại khác) đã bị đăng xuất.` : "Không có phiên nào khác đang mở."}
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="pw-current">Mật khẩu hiện tại</label>
        <input id="pw-current" type="password" className="input" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="pw-new">Mật khẩu mới</label>
        <input id="pw-new" type="password" className="input" autoComplete="new-password" minLength={MIN} value={next} onChange={(e) => setNext(e.target.value)} required />
        <div className="hint">Tối thiểu {MIN} ký tự. Không dùng lại mật khẩu tạm do quản trị cấp.</div>
      </div>
      <div className="field">
        <label htmlFor="pw-again">Nhập lại mật khẩu mới</label>
        <input id="pw-again" type="password" className="input" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
        {mismatch ? <div className="hint">Hai lần nhập chưa khớp.</div> : null}
      </div>
      <ErrorText error={error} />
      <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
        {busy ? "Đang đổi…" : "Đổi mật khẩu"}
      </button>
    </form>
  );
}
