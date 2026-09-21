import type { Tone } from "@/components/ui";

export const SWITCH_LABELS: Record<string, { label: string; hint: string }> = {
  "org:": { label: "Toàn bộ tự động của tổ chức", hint: "Dừng ở đây là dừng mọi trợ lý và mọi kênh gửi, bất kể công tắc riêng." },
  "agent:booking": { label: "Trợ lý 1 — Booking", hint: "Cập nhật booking từ tin nhắn/sự kiện trong phạm vi được cấp." },
  "agent:cleaning": { label: "Trợ lý 2 — Cleaning", hint: "Phân công, nhắc việc, hỗ trợ kiểm ảnh." },
  "agent:guest": { label: "Trợ lý 3 — Hỗ trợ khách", hint: "Tự trả lời Q&A đã duyệt, chuyển người khi cần." },
  "agent:guest_ai": { label: "Trợ lý AI soạn nháp cho khách (Claude)", hint: "Đọc tin khách bằng mọi ngôn ngữ, soạn nháp chỉ từ Kho Q&A đã duyệt. Luôn chờ người duyệt, không tự gửi. Có trần chi phí mỗi tháng." },
  "agent:staff_assist": { label: "Trợ lý trực nội bộ (Claude)", hint: "Tự trả lời tin nhắn của đội trên WhatsApp bằng số liệu trong hệ thống. Chỉ đọc, không sửa dữ liệu, không nhắn cho khách. Trong nhóm chỉ trả lời khi được gọi tên." },
  "agent:manager": { label: "Agent Manager", hint: "Đẩy cảnh báo lên cấp trên, gửi thông báo đội, gửi báo cáo." },
  "channel:whatsapp_staff": { label: "WhatsApp nội bộ (báo cho đội)", hint: "Tin cảnh báo/báo cáo gửi tới số của nhân viên. Tổng đài từng bị WhatsApp gỡ thiết bị — bật khi đã có mẫu duyệt và hạn mức." },
  "channel:whatsapp_guest": { label: "WhatsApp cho khách", hint: "Trợ lý trả lời khách qua WhatsApp." },
  "channel:report_delivery": { label: "Gửi báo cáo theo lịch", hint: "Tự lập và xếp hàng báo cáo đầu/cuối ngày theo đăng ký." },
};

export const AGENT_ROLE_LABELS: Record<string, string> = { booking: "Booking", cleaning: "Cleaning", guest: "Hỗ trợ khách", manager: "Manager" };

export const AGENT_RUN_STATUS_LABELS: Record<string, [string, Tone]> = {
  queued: ["Chờ chạy", "neutral"],
  running: ["Đang chạy", "info"],
  succeeded: ["Xong", "ok"],
  failed: ["Lỗi", "danger"],
  timed_out: ["Quá thời gian", "danger"],
  cancelled: ["Đã huỷ", "neutral"],
  skipped_paused: ["Bỏ qua — đang dừng", "warn"],
};

export const NOTIFICATION_STATUS_LABELS: Record<string, [string, Tone]> = {
  queued: ["Chờ gửi", "neutral"],
  sending: ["Đang gửi", "info"],
  sent: ["Đã gửi", "ok"],
  failed: ["Lỗi gửi", "danger"],
  suppressed: ["Không gửi", "warn"],
};

export const OUTBOX_STATUS_LABELS: Record<string, [string, Tone]> = {
  pending: ["Đang chờ", "neutral"],
  processing: ["Đang xử lý", "info"],
  dead: ["Hỏng", "danger"],
  done: ["Xong", "ok"],
};

export const TEMPLATE_STATUS_LABELS: Record<string, [string, Tone]> = {
  draft: ["Nháp — chưa dùng được", "warn"],
  approved: ["Đã duyệt", "ok"],
  retired: ["Ngừng dùng", "neutral"],
};

export const TEMPLATE_KEY_LABELS: Record<string, string> = {
  ticket_escalation: "Đẩy ticket khẩn lên cấp trên",
  handoff_request: "Khách cần chuyển người thật",
  daily_report: "Báo cáo ngày",
  system_alert: "Cảnh báo kỹ thuật",
  "inbox.handoff_requested": "Hộp thư: yêu cầu chuyển người (lần đầu)",
  "inbox.ticket_created": "Hộp thư: ticket mới",
  "inbox.ticket_assigned": "Hộp thư: ticket được giao",
};

export const SUBSCRIPTION_KIND_LABELS: Record<string, string> = { morning: "Báo cáo đầu ngày", evening: "Báo cáo cuối ngày", p1_alert: "Cảnh báo P1" };
export const CHANNEL_NAME_LABELS: Record<string, string> = { whatsapp: "WhatsApp", inapp: "Trong ứng dụng" };
