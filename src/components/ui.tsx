import Link from "next/link";
import type { ReactNode } from "react";
import { ClampText } from "./client";

/** Các khối giao diện dùng chung (server-safe). Màn hình mới phải dùng những khối này để thống nhất. */

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "demo";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Nhãn DEMO bắt buộc cạnh mọi dữ liệu mẫu / adapter demo. */
export function DemoBadge({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span className="badge badge-demo demo-mark" title="Dữ liệu mẫu ẩn danh — không phải dữ liệu vận hành thật">
      DEMO
    </span>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <ClampText>{description}</ClampText> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="card">
      {title || actions ? (
        <div className="card-header">
          <h2>{title}</h2>
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      <div className={pad ? "card-pad" : undefined}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, href, tone }: { label: string; value: ReactNode; sub?: ReactNode; href?: string; tone?: Tone }) {
  const body = (
    <div className="card stat" style={tone === "danger" ? { borderColor: "#f1b3ad" } : tone === "warn" ? { borderColor: "#f3d38a" } : undefined}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone === "danger" ? { color: "var(--danger)" } : tone === "warn" ? { color: "var(--warn)" } : undefined}>
        {value}
      </div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
  return href ? (
    <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
      {body}
    </Link>
  ) : (
    body
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "warn" | "danger" | "info" | "demo"; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <div>
        {title ? <div className="strong">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function KeyValue({ items, hideEmpty = false }: { items: [ReactNode, ReactNode][]; hideEmpty?: boolean }) {
  // hideEmpty: bỏ dòng không có giá trị để khối thông tin gọn (không hiện hàng loạt “—”).
  const rows = hideEmpty ? items.filter(([, v]) => v !== null && v !== undefined && v !== "") : items;
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tabs({ tabs, current }: { tabs: { href: string; label: ReactNode; key: string }[]; current: string }) {
  return (
    <nav className="tabs">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className="tab" aria-current={t.key === current ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function Pagination({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <div className="small faint">{total} dòng</div>;
  return (
    <div className="row small">
      <span className="faint">
        {total} dòng · trang {page}/{pages}
      </span>
      <span className="spacer" />
      {page > 1 ? (
        <Link className="btn btn-sm" href={hrefFor(page - 1)}>
          ← Trước
        </Link>
      ) : null}
      {page < pages ? (
        <Link className="btn btn-sm" href={hrefFor(page + 1)}>
          Sau →
        </Link>
      ) : null}
    </div>
  );
}

/** Khối thu gọn: phần tra cứu ít dùng (lịch sử, nhật ký kỹ thuật) — mặc định đóng để trang gọn. */
export function FoldCard({ title, hint, children, open = false }: { title: ReactNode; hint?: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="fold" open={open || undefined}>
      <summary>
        {title}
        {hint ? <span className="fold-hint">{hint}</span> : null}
      </summary>
      {children}
    </details>
  );
}

/** Ghi chú giải thích quy tắc: gập thành một dòng "ⓘ …", bấm mới mở — thay cho khối thông báo lớn luôn hiện. */
export function HelpNote({ title = "Cách hoạt động", children }: { title?: string; children: ReactNode }) {
  return (
    <details className="help-note">
      <summary>ⓘ {title}</summary>
      <div className="help-body">{children}</div>
    </details>
  );
}
