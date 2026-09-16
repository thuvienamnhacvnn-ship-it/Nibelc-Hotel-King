"use client";

import { useState } from "react";
import { ErrorText, callApi, type ApiError } from "@/components/client";

export function LoginForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setBusy(true);
        setError(null);
        const res = await callApi<{ redirectTo: string }>("/api/v1/auth/login", {
          body: { email: form.get("email"), password: form.get("password") },
        });
        setBusy(false);
        if (res.error) return setError(res.error);
        window.location.href = res.data?.redirectTo ?? "/";
      }}
    >
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" autoComplete="username" required />
      </div>
      <div className="field">
        <label htmlFor="password">Mật khẩu</label>
        <input id="password" name="password" type="password" className="input" autoComplete="current-password" required />
      </div>
      <ErrorText error={error} />
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
        {busy ? "Đang đăng nhập…" : "Đăng nhập"}
      </button>
    </form>
  );
}
