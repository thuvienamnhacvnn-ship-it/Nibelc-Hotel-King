import type { Actor } from "@/modules/auth/actor";
import type { Permission } from "@/modules/auth/permissions";

/**
 * Menu theo quyền. CHỈ liệt kê màn hình đã chạy thật — không đặt mục cho tính năng chưa làm
 * (Inbox, Q&A, Agent Center, Báo cáo thuộc Đợt 2–3, xem docs/TRUY-VET-YEU-CAU.md).
 */
export interface NavItem {
  href: string;
  label: string;
  icon: string;
  any: Permission[];
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Vận hành",
    items: [
      { href: "/", label: "Tổng quan hôm nay", icon: "LayoutDashboard", any: ["booking.view", "cleaning.view_all"] },
      { href: "/bookings", label: "Booking", icon: "BookOpen", any: ["booking.view"] },
      { href: "/lich", label: "Lịch phòng", icon: "CalendarDays", any: ["calendar.view"] },
      { href: "/duyet", label: "Chờ duyệt & xung đột", icon: "ShieldCheck", any: ["booking.request_change", "conflict.resolve", "booking.view"] },
    ],
  },
  {
    group: "Budapest",
    items: [
      { href: "/cleaning", label: "Điều phối cleaning", icon: "Sparkles", any: ["cleaning.view_all"] },
      { href: "/m", label: "Việc của tôi (mobile)", icon: "Smartphone", any: ["cleaning.own"] },
    ],
  },
  {
    group: "Dữ liệu",
    items: [
      { href: "/danh-muc", label: "Nhà / phòng / listing", icon: "Building2", any: ["catalog.view"] },
      { href: "/nhap-excel", label: "Nhập Excel", icon: "FileSpreadsheet", any: ["import.preview"] },
      { href: "/ket-noi", label: "Kết nối kênh", icon: "PlugZap", any: ["connector.view"] },
      { href: "/nhat-ky", label: "Nhật ký", icon: "History", any: ["audit.view"] },
    ],
  },
];

export function navFor(actor: Actor) {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.any.some((p) => actor.permissions.has(p))) })).filter((g) => g.items.length);
}
