"use client";

import {
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
  LogOut,
  Menu,
  PlugZap,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
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
  ShieldCheck,
  Smartphone,
  Sparkles,
};

export interface ShellNavGroup {
  group: string;
  items: { href: string; label: string; icon: string }[];
}

export function Shell({ nav, topbar, children }: { nav: ShellNavGroup[]; topbar: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <div className="shell" data-menu-open={open}>
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
                <Link key={item.href} href={item.href} className="nav-link" aria-current={isActive(item.href) ? "page" : undefined} onClick={() => setOpen(false)}>
                  <Icon size={18} aria-hidden />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </aside>
      <div className="main">
        <header className="topbar">
          <button type="button" className="btn btn-sm menu-toggle" onClick={() => setOpen((v) => !v)} aria-label="Mở menu">
            <Menu size={18} aria-hidden /> Menu
          </button>
          {topbar}
        </header>
        <main className="content">{children}</main>
      </div>
      <OfflineBanner />
    </div>
  );
}

export function LogoutButton() {
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        await callApi("/api/v1/auth/logout", { method: "POST", body: {} });
        window.location.href = "/login";
      }}
    >
      <LogOut size={16} aria-hidden /> Đăng xuất
    </button>
  );
}
