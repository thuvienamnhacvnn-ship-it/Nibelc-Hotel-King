import type { Tone } from "@/components/ui";
import type { Disposition } from "@/modules/imports/excel/issues";

export const BATCH_STATUS_LABELS: Record<string, string> = { previewed: "Đang xem trước", applied: "Đã áp dụng", discarded: "Đã huỷ" };

export function batchTone(status: string): Tone {
  return status === "applied" ? "ok" : status === "discarded" ? "neutral" : "info";
}

export function dispositionTone(d: Disposition | string): Tone {
  switch (d) {
    case "ready":
      return "info";
    case "applied":
      return "ok";
    case "needs_review":
    case "duplicate_in_file":
      return "warn";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}
