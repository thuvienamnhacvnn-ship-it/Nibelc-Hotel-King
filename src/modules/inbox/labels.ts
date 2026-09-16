/** Nhãn hiển thị của hộp thư — thuần, dùng được ở cả server và client. */

export const CONVERSATION_KINDS = ["guest", "staff", "group"] as const;
export const KIND_LABELS: Record<string, string> = { guest: "Khách", staff: "Nhân viên", group: "Nhóm", unknown: "Chưa rõ" };
export const INBOX_CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  viber: "Viber",
  webapp: "Webapp",
  airbnb: "Airbnb",
  booking_com: "Booking.com",
  internal: "Nội bộ",
};
export const MESSAGE_STATUS_LABELS: Record<string, string> = {
  received: "Đã nhận",
  draft: "Nháp — chờ duyệt",
  pending_approval: "Chờ duyệt",
  queued: "Đang chờ gửi",
  sending: "Đang gửi",
  sent: "Đã gửi",
  delivered: "Đã tới máy",
  read: "Đã đọc",
  failed: "Gửi thất bại",
  discarded: "Đã huỷ",
};
export const VERIFICATION_LABELS: Record<string, string> = { none: "Chưa xác minh", matched: "Đã khớp booking", verified: "Đã xác thực bổ sung" };
export const TICKET_STATUS_LABELS: Record<string, string> = {
  new: "Mới",
  assigned: "Đã giao",
  accepted: "Đã nhận",
  in_progress: "Đang xử lý",
  awaiting_guest: "Chờ khách",
  awaiting_vendor: "Chờ bên thứ ba",
  resolved: "Đã xử lý",
  verified: "Đã kiểm",
  closed: "Đóng",
};
export const TICKET_CATEGORY_LABELS: Record<string, string> = {
  access: "Vào nhà / mã cửa",
  maintenance: "Sửa chữa / sự cố",
  cleaning: "Dọn phòng",
  amenities: "Tiện nghi",
  booking_change: "Đổi booking",
  payment_refund: "Thanh toán / hoàn tiền",
  complaint: "Khiếu nại",
  question: "Câu hỏi",
  other: "Khác",
};
export const HANDOFF_STATUS_LABELS: Record<string, string> = {
  requested: "Chờ người nhận",
  accepted: "Đã có người nhận",
  escalated: "Đã đẩy lên cấp trên",
  callback: "Hẹn gọi lại",
  cancelled: "Đã huỷ",
};

export const TICKET_TRANSITIONS: Record<string, string[]> = {
  new: ["closed"],
  assigned: ["closed"],
  accepted: ["in_progress", "awaiting_guest", "awaiting_vendor", "resolved"],
  in_progress: ["awaiting_guest", "awaiting_vendor", "resolved"],
  awaiting_guest: ["in_progress", "resolved"],
  awaiting_vendor: ["in_progress", "resolved"],
  resolved: ["verified", "in_progress"],
  verified: ["closed"],
  closed: [],
};

