import type { OutboxHandler } from "@/modules/outbox/outbox";

/**
 * Chỗ các module đăng ký việc nền. Mỗi module Đợt 2 export từ `src/modules/<m>/jobs.ts`:
 *   export const handlers: Record<string, OutboxHandler>  — xử lý sự kiện outbox (idempotent)
 *   export const periodic: PeriodicJob[]                   — việc định kỳ (phải idempotent, chạy lại không hại)
 * Orchestrator nối vào worker ở `src/worker/main.ts`. Việc định kỳ lỗi chỉ ghi log, không làm dừng worker.
 */
export interface PeriodicJob {
  name: string;
  everyMs: number;
  run: () => Promise<Record<string, number> | void>;
}

export type { OutboxHandler };
