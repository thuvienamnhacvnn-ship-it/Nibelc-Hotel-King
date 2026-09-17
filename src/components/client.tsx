"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Gọi API /api/v1 từ client. Dùng cờ busy tự quản (không await server action trong startTransition —
 * React 19 làm kẹt isPending). Lỗi trả về theo chuẩn { error: { code, message, details } }.
 */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  status: number;
}

export async function callApi<T = unknown>(url: string, init: { method?: string; body?: unknown } = {}): Promise<{ data?: T; error?: ApiError }> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { error: { code: "offline", message: "Mất kết nối mạng — thao tác CHƯA được gửi. Thử lại khi có mạng.", status: 0 } };
  }
  try {
    const res = await fetch(url, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: init.body !== undefined && !(init.body instanceof FormData) ? { "content-type": "application/json" } : undefined,
      body: init.body === undefined ? undefined : init.body instanceof FormData ? init.body : JSON.stringify(init.body),
      credentials: "same-origin",
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login";
      return { error: { code: json?.error?.code ?? "http_error", message: json?.error?.message ?? `Lỗi ${res.status}`, details: json?.error?.details, status: res.status } };
    }
    return { data: json as T };
  } catch {
    return { error: { code: "network", message: "Không gửi được yêu cầu (mạng hoặc máy chủ). Thao tác CHƯA được ghi nhận.", status: 0 } };
  }
}

/** Hook cho một hành động: trạng thái bận, lỗi, và làm mới dữ liệu server sau khi thành công. */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function run<T>(url: string, init: { method?: string; body?: unknown } = {}, opts: { refresh?: boolean } = { refresh: true }) {
    setBusy(true);
    setError(null);
    const result = await callApi<T>(url, init);
    setBusy(false);
    if (result.error) setError(result.error);
    else if (opts.refresh !== false) router.refresh();
    return result;
  }
  return { run, busy, error, setError };
}

export function ErrorText({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const details = error.details as { conflicts?: { unit_code?: string | null; booking_ref?: string | null; start_date: string; end_date: string; block_reason?: string | null }[]; issues?: { message: string }[]; missing?: string[] } | undefined;
  return (
    <div className="form-error" role="alert">
      {error.message}
      {details?.conflicts?.length ? (
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {details.conflicts.map((c, i) => (
            <li key={i}>
              {c.block_reason ? `Chặn tồn: ${c.block_reason}` : `Booking ${c.booking_ref ?? "(không mã)"} · ${c.unit_code ?? ""}`} — {c.start_date} → {c.end_date}
            </li>
          ))}
        </ul>
      ) : null}
      {details?.issues?.length ? (
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {details.issues.map((c, i) => (
            <li key={i}>{c.message}</li>
          ))}
        </ul>
      ) : null}
      {details?.missing?.length ? <div>Còn thiếu: {details.missing.join(", ")}</div> : null}
    </div>
  );
}

/** Hộp thoại dùng thẻ <dialog> gốc. */
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <div className="card-header">
        <h2>{title}</h2>
        <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-footer">{footer}</div> : null}
    </dialog>
  );
}

/** Báo mất mạng toàn cục. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (!offline) return null;
  return <div className="offline-banner" role="status">Mất mạng — dữ liệu trên màn hình có thể đã cũ, thao tác chưa gửi được</div>;
}

/** Đoạn mô tả đầu trang: điện thoại chỉ hiện 2 dòng, chạm để xem đủ (máy tính luôn hiện đủ). */
export function ClampText({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <p data-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
      {children}
    </p>
  );
}

/**
 * Khung bộ lọc: máy tính luôn mở; điện thoại gập lại thành một dòng "Bộ lọc" (hiện số điều kiện đang áp dụng),
 * chạm để mở — danh sách hiện ngay dưới đầu trang thay vì phải cuộn qua cả form.
 */
export function FilterPanel({ active = 0, children, label = "Bộ lọc & tìm kiếm" }: { active?: number; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="filter-panel" data-open={open}>
      <button type="button" className="filter-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>
        <span className="spacer" style={{ textAlign: "left" }}>
          {label}
        </span>
        {active ? <span className="badge badge-info">{active} đang lọc</span> : null}
        <span aria-hidden style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .2s" }}>
          ▾
        </span>
      </button>
      <div className="filter-body">{children}</div>
    </div>
  );
}

/** Nút "⋯" mở menu thao tác phụ — giữ thẻ gọn, chỉ để nút chính nằm ngoài. Đóng khi bấm ra ngoài hoặc chọn mục. */
export function MoreMenu({ children, label = "Thao tác khác" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="more-menu" ref={ref}>
      <button type="button" className="btn btn-sm more-trigger" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open ? (
        <div className="menu-pop" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
