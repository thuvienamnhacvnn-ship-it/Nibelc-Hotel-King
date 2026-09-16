import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OutboxHandler } from "@/modules/outbox/outbox";
import { planCleaningForBooking } from "@/modules/cleaning/planner";
import type { PeriodicJob } from "./registry";

/**
 * Bộ xử lý sự kiện nền. Mỗi handler phải idempotent (có thể chạy lại cùng sự kiện).
 * Chủ đề chưa có handler được đánh dấu xong — các màn hình đọc thẳng từ bảng nghiệp vụ.
 *
 * Module Đợt 2 đăng ký việc nền qua `src/modules/<m>/jobs.ts` (xem registry.ts).
 */
const coreHandlers: Record<string, OutboxHandler> = {
  "booking.changed": async (event, tx) => {
    await planCleaningForBooking(tx, event.org_id, event.aggregate_id);
  },
};

export const JOB_MODULES = ["inbox", "qa", "photos", "manager", "icalsync"] as const;

async function loadModuleJobs() {
  const handlers: Record<string, OutboxHandler> = {};
  const periodic: PeriodicJob[] = [];
  const moduleDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../modules");
  for (const name of JOB_MODULES) {
    const file = path.join(moduleDir, name, "jobs.ts");
    if (!fs.existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)) as { handlers?: Record<string, OutboxHandler>; periodic?: PeriodicJob[] };
    for (const [topic, handler] of Object.entries(mod.handlers ?? {})) {
      if (handlers[topic] || coreHandlers[topic]) throw new Error(`Chủ đề outbox ${topic} bị đăng ký hai lần (module ${name})`);
      handlers[topic] = handler;
    }
    periodic.push(...(mod.periodic ?? []));
  }
  return { handlers, periodic };
}

const loaded = await loadModuleJobs();

export const handlers: Record<string, OutboxHandler> = { ...coreHandlers, ...loaded.handlers };
export const periodicJobs: PeriodicJob[] = loaded.periodic;
