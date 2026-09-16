import type { OutboxHandler } from "@/modules/outbox/outbox";
import { planCleaningForBooking } from "@/modules/cleaning/planner";

/**
 * Bộ xử lý sự kiện nền. Mỗi handler phải idempotent (có thể chạy lại cùng sự kiện).
 * Chủ đề chưa có handler (alert.*, cleaning_task.changed) được đánh dấu xong — các màn hình đọc thẳng
 * từ bảng nghiệp vụ; gửi thông báo ra ngoài thuộc Đợt 3 và chưa bật.
 */
export const handlers: Record<string, OutboxHandler> = {
  "booking.changed": async (event, tx) => {
    await planCleaningForBooking(tx, event.org_id, event.aggregate_id);
  },
};
