import type { Tone } from "@/components/ui";

export const UNIT_KIND_LABELS: Record<string, string> = { whole: "Nguyên căn", room: "Phòng lẻ", studio: "Studio" };

export const PROPERTY_STATUS_LABELS: Record<string, string> = { active: "Đang vận hành", inactive: "Tạm ngừng", historical: "Lịch sử" };

export const DATA_STATUS_LABELS: Record<string, string> = { confirmed: "Đã xác nhận", needs_confirmation: "Cần xác nhận" };

export const LISTING_STATUS_LABELS: Record<string, string> = {
  active: "Đang bán",
  blocked_by_platform: "Kênh đang khoá",
  inactive: "Ngừng",
  unknown: "Chưa rõ",
};

export const RESOURCE_KIND_LABELS: Record<string, string> = { room: "Phòng", studio: "Studio", shared_area: "Khu chung" };

export function listingTone(status: string): Tone {
  return ({ active: "ok", blocked_by_platform: "danger", inactive: "neutral", unknown: "warn" } as Record<string, Tone>)[status] ?? "neutral";
}

export function readinessTone(status: string): Tone {
  return (
    ({ ready: "ok", unknown: "neutral", occupied: "info", cleaning: "info", vacated_dirty: "warn", inspection_pending: "warn", out_of_service: "danger" } as Record<string, Tone>)[status] ??
    "neutral"
  );
}
