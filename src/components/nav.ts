import type { Actor } from "@/modules/auth/actor";
import type { Permission } from "@/modules/auth/permissions";

/**
 * Menu theo quyền. CHỈ liệt kê màn hình đã chạy thật — không đặt mục cho tính năng chưa làm
 * Mục Đợt 2 chỉ thêm khi màn hình đã chạy thật (hộp thư, Q&A, báo cáo, Agent Center).
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
      { href: "/", label: "Tổng quan", icon: "LayoutDashboard", any: ["booking.view", "cleaning.view_all"] },
      { href: "/bookings", label: "Booking", icon: "BookOpen", any: ["booking.view"] },
      { href: "/lich", label: "Lịch phòng", icon: "CalendarDays", any: ["calendar.view"] },
      { href: "/duyet", label: "Duyệt & xung đột", icon: "ShieldCheck", any: ["booking.request_change", "conflict.resolve", "booking.view"] },
      { href: "/hop-thu", label: "Hộp thư", icon: "MessagesSquare", any: ["inbox.view"] },
      { href: "/kho-qa", label: "Kho Q&A", icon: "LibraryBig", any: ["qa.view"] },
    ],
  },
  {
    group: "Buồng phòng",
    items: [
      { href: "/cleaning", label: "Dọn phòng", icon: "Sparkles", any: ["cleaning.view_all"] },
      { href: "/m", label: "Việc của tôi", icon: "Smartphone", any: ["cleaning.own"] },
    ],
  },
  {
    group: "Dữ liệu",
    items: [
      { href: "/danh-muc", label: "Nhà & phòng", icon: "Building2", any: ["catalog.view"] },
      { href: "/nhap-excel", label: "Nhập Excel", icon: "FileSpreadsheet", any: ["import.preview"] },
      { href: "/ket-noi", label: "Kết nối kênh", icon: "PlugZap", any: ["connector.view"] },
      { href: "/nhat-ky", label: "Nhật ký", icon: "History", any: ["audit.view"] },
    ],
  },
  {
    group: "Quản lý",
    items: [
      { href: "/bao-cao", label: "Báo cáo", icon: "FileBarChart", any: ["reports.view"] },
      { href: "/agent-center", label: "Agent Center", icon: "Bot", any: ["automation.pause", "reports.view"] },
    ],
  },
];

export function navFor(actor: Actor) {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.any.some((p) => actor.permissions.has(p))) })).filter((g) => g.items.length);
}
