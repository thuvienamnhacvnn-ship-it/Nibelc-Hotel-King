"use client";

import {
  BookOpen,
  Bot,
  ChevronLeft,
  FileBarChart,
  LibraryBig,
  MessagesSquare,
  Building2,
  CalendarDays,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Plus,
  PlugZap,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserCog,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { OfflineBanner, callApi } from "./client";

const ICONS: Record<string, typeof BookOpen> = {
  BookOpen,
  Bot,
  FileBarChart,
  LibraryBig,
  MessagesSquare,
  Building2,
  CalendarDays,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  PlugZap,
  Plus,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserCog,
  Users,
};

export interface ShellNavGroup {
  group: string;
  items: { href: string; label: string; icon: string }[];
}

/** Thông tin cho khung điện thoại (thanh tiêu đề, tab đáy, bảng "Thêm"). */
export interface ShellMobile {
  orgName: string;
  isDemo: boolean;
  userName: string;
  roleLabel: string;
  dateLabel: string;
  workerAlive: boolean;
  badges: Record<string, number>;
  quickActions: { href: string; label: string; icon: string }[];
}

/** Thứ tự ưu tiên chọn 4 tab đáy — lấy 4 mục đầu tiên người dùng có quyền. */
const TAB_PRIORITY = ["/", "/bookings", "/lich", "/hop-thu", "/cleaning", "/duyet", "/m", "/bao-cao", "/kho-qa", "/danh-muc"];
const SHORT_LABELS: Record<string, string> = {
  "/": "Hôm nay",
  "/bookings": "Booking",
  "/lich": "Lịch",
  "/hop-thu": "Hộp thư",
  "/cleaning": "Dọn phòng",
  "/duyet": "Duyệt",
  "/m": "Việc tôi",
  "/bao-cao": "Báo cáo",
  "/kho-qa": "Q&A",
  "/danh-muc": "Danh mục",
};

function initials(name: string) {
  const base = name.split(/\s+[—-]\s+/)[0] ?? name;
  const parts = base.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

function BadgeCount({ n }: { n?: number }) {
  if (!n) return null;
  return <span className="count-dot">{n > 99 ? "99+" : n}</span>;
}

export function Shell({ nav, topbar, mobile, children }: { nav: ShellNavGroup[]; topbar: ReactNode; mobile: ShellMobile; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sheet, setSheet] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const items = nav.flatMap((g) => g.items);
  const current = items.filter((i) => isActive(i.href)).sort((a, b) => b.href.length - a.href.length)[0];
  // Trang con (chi tiết booking, việc dọn…) thì hiện nút quay lại thay cho logo.
  const isDetail = !!current && pathname !== current.href;
  const tabs = TAB_PRIORITY.map((h) => items.find((i) => i.href === h)).filter((i): i is NonNullable<typeof i> => !!i).slice(0, 4);
  const moreActive = !!current && !tabs.some((t) => t.href === current.href);
  const moreBadge = Object.entries(mobile.badges)
    .filter(([href]) => !tabs.some((t) => t.href === href))
    .reduce((s, [, n]) => s + n, 0);

  // Đóng bảng khi đổi trang; khoá cuộn nền khi bảng mở; Esc để đóng.
  useEffect(() => setSheet(false), [pathname]);
  useEffect(() => {
    if (!sheet) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [sheet]);

  return (
    <div className="shell" data-demo-org={mobile.isDemo ? "true" : undefined}>
      <aside className="sidebar" aria-label="Điều hướng chính">
        <Link href="/" className="brand" aria-label="Vietduc Hotel — về trang chính">
          {/* Logo Việt Đức Group nền trong suốt, đặt thẳng trên menu */}
          <span className="brand-plate">
            <img src="/logo-vietduc.png" alt="Việt Đức Group" width={110} height={104} />
          </span>
          <span className="brand-name">Vietduc Hotel</span>
        </Link>
        {nav.map((g) => (
          <div key={g.group}>
            <div className="nav-group">{g.group}</div>
            {g.items.map((item) => {
              const Icon = ICONS[item.icon] ?? LayoutDashboard;
              return (
                <Link key={item.href} href={item.href} className="nav-link" aria-current={isActive(item.href) ? "page" : undefined}>
                  <Icon size={18} aria-hidden />
                  <span className="spacer">{item.label}</span>
                  <BadgeCount n={mobile.badges[item.href]} />
                </Link>
              );
            })}
          </div>
        ))}
      </aside>

      <div className="main">
        {/* Máy tính: thanh trên đầy đủ */}
        <header className="topbar">{topbar}</header>

        {/* Điện thoại: thanh tiêu đề gọn kiểu app */}
        <header className="appbar">
          {isDetail ? (
            <button type="button" className="appbar-icon" onClick={() => router.back()} aria-label="Quay lại">
              <ChevronLeft size={24} aria-hidden />
            </button>
          ) : (
            <Link href="/" className="appbar-logo" aria-label="Về trang chính">
              <img src="/icon.png" alt="" width={30} height={30} />
            </Link>
          )}
          <div className="appbar-title">
            <span className="appbar-name">{current?.label ?? "Vietduc Hotel"}</span>
            <span className="appbar-sub">
              <span className={`live-dot ${mobile.workerAlive ? "on" : "off"}`} aria-label={mobile.workerAlive ? "Hệ thống nền đang chạy" : "Hệ thống nền không chạy"} />
              {mobile.dateLabel}
              {mobile.isDemo ? <span className="appbar-demo">DEMO</span> : null}
            </span>
          </div>
          <button type="button" className="avatar" onClick={() => setSheet(true)} aria-label="Tài khoản và menu">
            {initials(mobile.userName)}
          </button>
        </header>

        <main className="content">{children}</main>
      </div>

      {/* Điện thoại: tab đáy */}
      <nav className="tabbar" aria-label="Điều hướng nhanh">
        {tabs.map((t) => {
          const Icon = ICONS[t.icon] ?? LayoutDashboard;
          const active = current?.href === t.href;
          return (
            <Link key={t.href} href={t.href} className="tab-item" aria-current={active ? "page" : undefined}>
              <span className="tab-icon">
                <Icon size={22} strokeWidth={active ? 2.4 : 1.9} aria-hidden />
                <BadgeCount n={mobile.badges[t.href]} />
              </span>
              <span className="tab-label">{SHORT_LABELS[t.href] ?? t.label}</span>
            </Link>
          );
        })}
        <button type="button" className="tab-item" aria-current={moreActive || sheet ? "page" : undefined} onClick={() => setSheet(true)} aria-haspopup="dialog">
          <span className="tab-icon">
            <LayoutGrid size={22} strokeWidth={moreActive ? 2.4 : 1.9} aria-hidden />
            <BadgeCount n={moreBadge} />
          </span>
          <span className="tab-label">Thêm</span>
        </button>
      </nav>

      {/* Bảng "Thêm": tài khoản, thao tác nhanh, toàn bộ chức năng */}
      <div className="sheet-backdrop" data-open={sheet} onClick={() => setSheet(false)} aria-hidden />
      <div className="sheet" data-open={sheet} role="dialog" aria-modal="true" aria-label="Menu" inert={!sheet}>
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <span className="avatar avatar-lg">{initials(mobile.userName)}</span>
          <div className="sheet-who">
            <div className="strong">{mobile.userName}</div>
            <div className="small muted">
              {mobile.roleLabel} · {mobile.orgName}
            </div>
          </div>
          <button type="button" className="appbar-icon dark" onClick={() => setSheet(false)} aria-label="Đóng">
            <X size={22} aria-hidden />
          </button>
        </div>

        {mobile.quickActions.length ? (
          <div className="quick-row">
            {mobile.quickActions.map((q) => {
              const Icon = ICONS[q.icon] ?? Plus;
              return (
                <Link key={q.href} href={q.href} className="quick-action">
                  <Icon size={18} aria-hidden /> {q.label}
                </Link>
              );
            })}
          </div>
        ) : null}

        {nav.map((g) => (
          <section key={g.group} className="sheet-group">
            <div className="sheet-group-title">{g.group}</div>
            <div className="tile-grid">
              {g.items.map((item) => {
                const Icon = ICONS[item.icon] ?? LayoutDashboard;
                return (
                  <Link key={item.href} href={item.href} className="tile" aria-current={current?.href === item.href ? "page" : undefined}>
                    <span className="tile-icon">
                      <Icon size={22} aria-hidden />
                      <BadgeCount n={mobile.badges[item.href]} />
                    </span>
                    <span className="tile-label">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}

        <div className="sheet-foot">
          <LogoutButton block />
          <div className="small faint" style={{ textAlign: "center" }}>
            Vietduc Hotel · {mobile.isDemo ? "dữ liệu DEMO" : "dữ liệu vận hành"}
          </div>
        </div>
      </div>

      <TableCards title={isDetail ? undefined : current?.label} />
      <OfflineBanner />
    </div>
  );
}

/**
 * Điện thoại: bảng dữ liệu hiển thị thành thẻ. Gắn nhãn cột (data-label) cho từng ô dựa theo tiêu đề bảng,
 * CSS lo phần hiển thị. Bảng nào cần giữ cuộn ngang thì đặt data-mobile="scroll".
 */
function TableCards({ title }: { title?: string }) {
  const pathname = usePathname();
  useEffect(() => {
    // React gắn khoá __reactFiber… vào phần tử khi đã hydrate. Chỉ sửa DOM phần đã hydrate — sửa sớm hơn
    // sẽ lệch với HTML server (lỗi hydration). Phần chưa hydrate (đang stream) thì thử lại sau.
    const hydrated = (el: Element) => Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    const label = (): boolean => {
      let pending = false;
      // Tiêu đề trang trùng tên trên thanh app thì ẩn bớt trên điện thoại.
      const h1 = document.querySelector<HTMLElement>("main .page-header h1");
      if (h1) {
        if (!hydrated(h1)) pending = true;
        else if (title && h1.textContent?.trim() === title) h1.dataset.dup = "1";
        else delete h1.dataset.dup;
      }
      document.querySelectorAll<HTMLTableElement>("main table.table:not([data-mobile='scroll'])").forEach((table) => {
        const headRow = table.tHead?.rows[0];
        if (!headRow) return;
        if (!hydrated(table)) {
          pending = true;
          return;
        }
        const heads: string[] = [];
        for (const th of Array.from(headRow.cells)) for (let i = 0; i < th.colSpan; i++) heads.push(th.textContent?.trim() ?? "");
        for (const body of Array.from(table.tBodies)) {
          for (const tr of Array.from(body.rows)) {
            let col = 0;
            for (const td of Array.from(tr.cells)) {
              const text = heads[col] ?? "";
              if (td.dataset.label !== text) td.dataset.label = text;
              if (td.colSpan > 1) td.dataset.wide = "1";
              const empty = !td.querySelector("input,select,textarea,button,a,img,svg") && /^[—–-]?$/.test(td.textContent?.trim() ?? "");
              if (empty) td.dataset.empty = "1";
              else delete td.dataset.empty;
              col += td.colSpan;
            }
          }
        }
      });
      return pending;
    };
    const main = document.querySelector("main");
    if (!main) return;
    let raf = 0;
    let timer = 0;
    let tries = 0;
    const run = () => {
      if (label() && tries++ < 60) timer = window.setTimeout(run, 250);
    };
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        tries = 0;
        window.clearTimeout(timer);
        run();
      });
    });
    obs.observe(main, { childList: true, subtree: true });
    run();
    return () => {
      window.clearTimeout(timer);
      obs.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [pathname, title]);
  return null;
}

export function LogoutButton({ block = false }: { block?: boolean }) {
  return (
    <button
      type="button"
      className={block ? "btn btn-lg btn-block btn-danger" : "btn btn-sm"}
      onClick={async () => {
        await callApi("/api/v1/auth/logout", { method: "POST", body: {} });
        window.location.href = "/login";
      }}
    >
      <LogOut size={16} aria-hidden /> Đăng xuất
    </button>
  );
}
