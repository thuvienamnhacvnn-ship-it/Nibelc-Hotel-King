import type { Tone } from "@/components/ui";

export const CONNECTOR_STATUS_LABELS: Record<string, string> = {
  not_configured: "Chưa cấu hình",
  demo: "Demo",
  testing: "Thử nghiệm",
  active: "Hoạt động",
  error: "Lỗi",
};

export function connectorTone(status: string): Tone {
  return ({ not_configured: "neutral", demo: "demo", testing: "info", active: "ok", error: "danger" } as Record<string, Tone>)[status] ?? "neutral";
}
