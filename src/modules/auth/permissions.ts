/**
 * Phân quyền theo vai trò. Kiểm ở server trong từng service — giao diện ẩn nút chỉ là tiện lợi.
 * Nguồn: file "Thông tin build app update _Vietnam Team" mục 4 + đặc tả 16/09 mục 5.
 * Các điểm còn chờ chốt được ghi trong docs/QUYET-DINH-CAN-CHOT.md (ví dụ: vn_staff có xem doanh thu không).
 */

export const ROLES = ["admin", "leader", "vn_manager", "vn_staff", "bp_coordinator", "bp_staff", "cleaner", "manager_viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Quản trị hệ thống",
  leader: "Leader — quyết định cuối",
  vn_manager: "Vietnam Team — phụ trách chính",
  vn_staff: "Vietnam Team",
  bp_coordinator: "Budapest Team — điều phối",
  bp_staff: "Budapest Team",
  cleaner: "Cleaner",
  manager_viewer: "Quản lý (xem báo cáo)",
};

export const PERMISSIONS = [
  "booking.view",
  "booking.view_guest_contact",
  "booking.create",
  "booking.edit",
  "booking.request_change",
  "booking.approve_change",
  "booking.stay_status",
  "revenue.view",
  "catalog.view",
  "catalog.edit",
  "calendar.view",
  "inventory.block",
  "conflict.resolve",
  "cleaning.view_all",
  "cleaning.manage",
  "cleaning.own",
  "readiness.approve",
  "import.preview",
  "import.apply",
  "connector.view",
  "connector.manage",
  "automation.pause",
  "audit.view",
  "reports.view",
  "users.manage",
  // Đợt 2
  "inbox.view",
  "inbox.reply",
  "inbox.takeover",
  "tickets.manage",
  "qa.view",
  "qa.edit",
  "qa.approve",
  "templates.approve",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: ALL,
  // Leader: xem và duyệt mọi nghiệp vụ; quản trị tài khoản/kỹ thuật vẫn thuộc admin.
  leader: new Set<Permission>(PERMISSIONS.filter((p) => p !== "users.manage" && p !== "connector.manage")),
  vn_manager: new Set<Permission>([
    "inbox.view",
    "inbox.reply",
    "inbox.takeover",
    "tickets.manage",
    "qa.view",
    "qa.edit",
    "qa.approve",
    "templates.approve",
    "booking.view",
    "booking.view_guest_contact",
    "booking.create",
    "booking.edit",
    "booking.request_change",
    "booking.approve_change",
    "booking.stay_status",
    "revenue.view",
    "catalog.view",
    "catalog.edit",
    "calendar.view",
    "inventory.block",
    "conflict.resolve",
    "cleaning.view_all",
    "import.preview",
    "import.apply",
    "connector.view",
    "automation.pause",
    "audit.view",
    "reports.view",
  ]),
  vn_staff: new Set<Permission>([
    "inbox.view",
    "inbox.reply",
    "inbox.takeover",
    "tickets.manage",
    "qa.view",
    "qa.edit",
    "booking.view",
    "booking.view_guest_contact",
    "booking.create",
    "booking.edit",
    "booking.request_change",
    "booking.stay_status",
    "catalog.view",
    "calendar.view",
    "cleaning.view_all",
    "import.preview",
    "connector.view",
  ]),
  bp_coordinator: new Set<Permission>([
    "inbox.view",
    "inbox.reply",
    "inbox.takeover",
    "tickets.manage",
    "qa.view",
    "qa.edit",
    "qa.approve",
    "booking.view",
    "booking.view_guest_contact",
    "booking.request_change",
    "booking.stay_status",
    "catalog.view",
    "calendar.view",
    "inventory.block",
    "cleaning.view_all",
    "cleaning.manage",
    "readiness.approve",
    "connector.view",
    "reports.view",
  ]),
  bp_staff: new Set<Permission>([
    "inbox.view",
    "tickets.manage",
    "qa.view",
    "booking.view",
    "booking.stay_status",
    "catalog.view",
    "calendar.view",
    "cleaning.view_all",
    "readiness.approve",
  ]),
  // Cleaner chỉ thấy việc được giao và thông tin cần cho việc đó.
  cleaner: new Set<Permission>(["cleaning.own"]),
  manager_viewer: new Set<Permission>([
    "inbox.view",
    "qa.view",
    "booking.view",
    "revenue.view",
    "catalog.view",
    "calendar.view",
    "cleaning.view_all",
    "connector.view",
    "audit.view",
    "reports.view",
  ]),
};

export function permissionsFor(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role] ?? new Set();
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
