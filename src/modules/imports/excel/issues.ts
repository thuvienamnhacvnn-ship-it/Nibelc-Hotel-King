/**
 * Mã lý do kiểm tra của dòng nhập. `block` ⇒ dòng không được áp dụng tự động (needs_review);
 * `warn` ⇒ vẫn áp dụng được nhưng hiện cảnh báo để người kiểm tra biết.
 */
export const ISSUE_DEFS = {
  missing_ref: { severity: "block", label: "Thiếu mã đặt phòng" },
  duplicate_ref_in_file: { severity: "block", label: "Mã đặt phòng lặp trong file" },
  guest_missing: { severity: "block", label: "Thiếu tên khách" },
  stay_date_invalid: { severity: "block", label: "Không đọc được ngày nhận/trả phòng" },
  stay_date_ambiguous: { severity: "block", label: "Ngày ở là ô Date có thể bị đảo ngày/tháng" },
  stay_date_order: { severity: "block", label: "Ngày trả không sau ngày nhận" },
  stay_too_long: { severity: "block", label: "Kỳ ở dài bất thường" },
  nights_mismatch: { severity: "block", label: "Số đêm không khớp ngày nhận/trả" },
  unit_missing: { severity: "block", label: "Trống cột căn hộ" },
  unit_unmapped: { severity: "block", label: "Tên căn/phòng chưa có alias" },
  unit_multiple: { severity: "block", label: "Nhiều phòng trong một dòng" },
  unit_moved: { severity: "block", label: "Có chuyển phòng (=>)" },
  capacity_exceeded: { severity: "block", label: "Số khách vượt sức chứa" },
  channel_unknown: { severity: "block", label: "Không nhận ra kênh bán" },
  status_conflict: { severity: "block", label: "Mâu thuẫn: có chữ hủy nhưng trạng thái đã hoàn tất" },
  cancel_mentioned: { severity: "block", label: "Ghi chú nhắc tới hủy" },
  no_show_mentioned: { severity: "block", label: "Ghi chú đánh dấu vắng mặt" },
  cancel_sheet: { severity: "block", label: "Dòng ở sheet Hủy" },
  note_payment: { severity: "warn", label: "Ghi chú là khoản thu, không phải kênh" },
  booked_date_missing: { severity: "warn", label: "Thiếu ngày nhận booking" },
  booked_date_invalid: { severity: "warn", label: "Không đọc được ngày nhận booking" },
  booked_date_cell_ambiguous: { severity: "warn", label: "Ngày nhận booking là ô Date, ngày ≤ 12 (có thể đảo)" },
  booked_after_checkin: { severity: "warn", label: "Ngày nhận booking sau ngày nhận phòng" },
  guests_invalid: { severity: "warn", label: "Tổng số khách không phải số" },
  room_type_mismatch: { severity: "warn", label: "Loại phòng không khớp sản phẩm" },
  ref_channel_mismatch: { severity: "warn", label: "Dạng mã không giống kênh ghi chú" },
  ref_exists_other_channel: { severity: "warn", label: "Mã đã có trong hệ thống ở kênh khác" },
  house_sheet_mismatch: { severity: "warn", label: "Sheet nhà ghi khác sheet nguồn" },
  also_in_source_sheet: { severity: "warn", label: "Mã cũng có ở sheet nguồn" },
  only_in_house_sheet: { severity: "warn", label: "Chỉ có ở sheet nhà, không có ở sheet nguồn" },
  past_stay_skipped: { severity: "warn", label: "Bỏ qua khi áp dụng: đã trả phòng trước mốc chọn" },
  apply_error: { severity: "block", label: "Lỗi khi áp dụng" },
} as const;

export type IssueCode = keyof typeof ISSUE_DEFS;

export interface RowIssue {
  code: IssueCode;
  severity: "block" | "warn";
  message: string;
  detail?: unknown;
}

export function issue(code: IssueCode, message: string, detail?: unknown): RowIssue {
  return { code, severity: ISSUE_DEFS[code].severity, message, ...(detail !== undefined ? { detail } : {}) };
}

export const DISPOSITIONS = ["ready", "needs_review", "duplicate_in_file", "already_imported", "skipped", "applied", "error"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  ready: "Hợp lệ, chờ áp dụng",
  needs_review: "Cần kiểm tra",
  duplicate_in_file: "Mã lặp trong file",
  already_imported: "Đã có trong hệ thống",
  skipped: "Không áp dụng",
  applied: "Đã áp dụng",
  error: "Lỗi khi áp dụng",
};

export const ISSUE_LABELS: Record<string, string> = Object.fromEntries(Object.entries(ISSUE_DEFS).map(([k, v]) => [k, v.label]));
