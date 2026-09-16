import type { Tone } from "@/components/ui";
import { formatDateVi, formatInstant } from "@/lib/time";
import { TASK_KIND_LABELS } from "@/modules/cleaning/service";

/** Định dạng dùng chung cho màn hình điều phối, chi tiết việc và mobile cleaner (không chứa dữ liệu khách). */

export function statusTone(status: string): Tone {
  switch (status) {
    case "pending_assignment":
      return "warn";
    case "needs_reclean":
      return "danger";
    case "awaiting_inspection":
    case "in_progress":
    case "accepted":
      return "info";
    case "passed":
      return "ok";
    default:
      return "neutral";
  }
}

export interface ChangeValues {
  cancel?: boolean;
  kind?: string;
  service_date?: string;
  due_at?: string | Date;
  earliest_start_at?: string | Date;
  arriving_booking_id?: string | null;
  reason?: string;
}

/** Các dòng "trường: trước → sau" cho thay đổi chờ xác nhận. `before` có thể thiếu (sự kiện cũ trong lịch sử). */
export function changeRows(after: ChangeValues, before: ChangeValues | null, tz: string): { label: string; before: string | null; after: string }[] {
  if (after.cancel) {
    return [{ label: "Việc dọn", before: before ? "Vẫn làm" : null, after: "Đề nghị KHÔNG dọn nữa (booking hủy / đổi phòng)" }];
  }
  const rows: { label: string; before: string | null; after: string }[] = [];
  const add = (label: string, b: string | null, a: string) => {
    if (!before || b !== a) rows.push({ label, before: before ? b : null, after: a });
  };
  if (after.kind !== undefined) add("Loại việc", before?.kind ? (TASK_KIND_LABELS[before.kind] ?? before.kind) : null, TASK_KIND_LABELS[after.kind] ?? after.kind);
  if (after.service_date !== undefined) add("Ngày dọn", before?.service_date ? formatDateVi(before.service_date) : null, formatDateVi(after.service_date));
  if (after.earliest_start_at !== undefined) add("Sớm nhất bắt đầu", before?.earliest_start_at ? formatInstant(before.earliest_start_at, tz) : null, formatInstant(after.earliest_start_at, tz));
  if (after.due_at !== undefined) add("Hạn hoàn thành", before?.due_at ? formatInstant(before.due_at, tz) : null, formatInstant(after.due_at, tz));
  if (after.arriving_booking_id !== undefined) {
    const other = before?.arriving_booking_id && after.arriving_booking_id && before.arriving_booking_id !== after.arriving_booking_id;
    add("Khách đến tiếp", before ? (before.arriving_booking_id ? "Có" : "Không có") : null, other ? "Có — booking khác" : after.arriving_booking_id ? "Có" : "Không có");
  }
  return rows;
}
