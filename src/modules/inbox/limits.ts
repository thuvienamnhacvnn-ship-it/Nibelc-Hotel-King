/**
 * Hạn mức gửi WhatsApp — MỘT chỗ duy nhất. Số tổng đài từng bị WhatsApp gỡ thiết bị sau đợt nhắn nên mọi trần đều chặt.
 * CÁC CON SỐ LÀ ĐỀ XUẤT, CHỜ CHỐT với Ngọc/Dịu (xem docs/QUYET-DINH-CAN-CHOT.md khi có).
 */
export const SEND_LIMITS = {
  /** Khoảng cách tối thiểu giữa hai lần gửi trên cùng một connector (đề xuất, chờ chốt). */
  intervalMs: 3000,
  /** Trần tổng mỗi connector trong 60 phút — tin khách + thông báo đội (đề xuất, chờ chốt). */
  connectorPerHour: 30,
  /** Bot tự gửi tối đa bao nhiêu tin cho một hội thoại trong 60 phút (đề xuất, chờ chốt). */
  botPerConversationHour: 3,
  /** Bot tự gửi cách nhau tối thiểu trong một hội thoại (đề xuất, chờ chốt). */
  botConversationGapMs: 2 * 60_000,
  /** Tin bot tự gửi nằm hàng đợi quá lâu thì bỏ — câu trả lời đã cũ (đề xuất, chờ chốt). */
  botQueueTtlMs: 10 * 60_000,
  /** Tin do người viết/duyệt nằm hàng đợi quá lâu thì bỏ — người phải xem lại trước khi gửi (đề xuất, chờ chốt). */
  staffQueueTtlMs: 2 * 60 * 60_000,
  /** Tin 'sending' quá lâu = tiến trình chết giữa chừng. */
  stuckSendingMs: 120_000,
} as const;
