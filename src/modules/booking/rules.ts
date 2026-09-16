/**
 * Quy tắc kinh doanh đã có trong file Vietnam Team.
 * Khoản phí/giảm giá chưa rõ cách áp dụng để ở trạng thái CHƯA KÍCH HOẠT (active: false) — không tự cộng vào booking,
 * tránh thu hai lần với giá OTA. Xem docs/QUYET-DINH-CAN-CHOT.md.
 */

export const STAY_RULES = {
  earliestEarlyCheckIn: "12:00",
  latestLateCheckOut: "13:00",
} as const;

export interface FeeRule {
  key: string;
  label: string;
  amountMinor: number;
  currency: "EUR";
  appliesTo: string;
  active: boolean;
  pendingQuestion: string;
}

export const FEE_RULES: FeeRule[] = [
  {
    key: "cleaning_room",
    label: "Phí vệ sinh phòng lẻ",
    amountMinor: 2000,
    currency: "EUR",
    appliesTo: "room",
    active: false,
    pendingQuestion: "Đã nằm trong giá OTA hay thu riêng? Tính mỗi kỳ ở hay mỗi lần dọn?",
  },
  {
    key: "cleaning_whole",
    label: "Phí vệ sinh nguyên căn",
    amountMinor: 3000,
    currency: "EUR",
    appliesTo: "whole",
    active: false,
    pendingQuestion: "Đã nằm trong giá OTA hay thu riêng? Tính mỗi kỳ ở hay mỗi lần dọn?",
  },
  {
    key: "early_late_room",
    label: "Phụ thu nhận sớm / trả muộn — phòng lẻ",
    amountMinor: 2000,
    currency: "EUR",
    appliesTo: "room",
    active: false,
    pendingQuestion: "Khách dùng cả nhận sớm và trả muộn thì thu một hay hai lần?",
  },
  {
    key: "early_late_whole_small",
    label: "Phụ thu nhận sớm / trả muộn — nguyên căn dưới 5 phòng",
    amountMinor: 3000,
    currency: "EUR",
    appliesTo: "whole<5",
    active: false,
    pendingQuestion: "Khách dùng cả nhận sớm và trả muộn thì thu một hay hai lần?",
  },
  {
    key: "early_late_whole_large",
    label: "Phụ thu nhận sớm / trả muộn — nguyên căn từ 5 phòng",
    amountMinor: 3500,
    currency: "EUR",
    appliesTo: "whole>=5",
    active: false,
    pendingQuestion: "Khách dùng cả nhận sớm và trả muộn thì thu một hay hai lần?",
  },
];

export const DISCOUNT_RULES = [
  { key: "weekly", label: "Giảm giá theo tuần", percent: 10, active: false, pendingQuestion: "Số đêm tối thiểu? Có cộng dồn với khuyến mại OTA không?" },
  { key: "monthly", label: "Giảm giá theo tháng", percent: 15, active: false, pendingQuestion: "Số đêm tối thiểu? Thứ tự áp dụng với giảm tuần?" },
];
