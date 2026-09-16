/**
 * Worker nền: xử lý outbox (lập việc dọn khi booking đổi, ...) và việc định kỳ của các module
 * (đẩy cảnh báo lên cấp trên, gửi thông báo đội, lập báo cáo ngày).
 * Chạy: `npm run worker` (giữ mở cạnh `npm run dev`). Web vẫn chạy được khi worker tắt — việc chỉ chậm cập nhật,
 * và màn hình Tổng quan hiện số sự kiện đang chờ để người vận hành biết.
 */
import { loadLocalEnv } from "@/lib/env";

loadLocalEnv();

const { closePool, query } = await import("@/lib/db");
const { drainOutbox } = await import("@/modules/outbox/outbox");
const { handlers, periodicJobs } = await import("./handlers");

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
let stopping = false;
const lastRun = new Map<string, number>();

async function heartbeat(stats: Record<string, unknown>) {
  await query(
    `INSERT INTO system_heartbeats (name, last_beat_at, detail) VALUES ('worker', now(), $1)
     ON CONFLICT (name) DO UPDATE SET last_beat_at = now(), detail = EXCLUDED.detail`,
    [JSON.stringify({ pid: process.pid, ...stats })],
  );
}

async function runPeriodic() {
  const results: Record<string, string> = {};
  for (const job of periodicJobs) {
    const due = (lastRun.get(job.name) ?? 0) + job.everyMs <= Date.now();
    if (!due) continue;
    lastRun.set(job.name, Date.now());
    try {
      const out = await job.run();
      if (out && Object.values(out).some((v) => v)) console.log(`[worker] ${job.name}:`, out);
      results[job.name] = "ok";
    } catch (error) {
      results[job.name] = "error";
      console.error(`[worker] việc định kỳ ${job.name} lỗi:`, (error as Error).message);
    }
  }
  return results;
}

async function loop() {
  console.log(`[worker] bắt đầu, nhịp ${POLL_MS}ms, ${periodicJobs.length} việc định kỳ: ${periodicJobs.map((j) => j.name).join(", ") || "(chưa có)"}`);
  while (!stopping) {
    try {
      const stats = await drainOutbox(handlers, 10);
      if (stats.done || stats.retry || stats.dead) console.log(`[worker] xong ${stats.done}, thử lại ${stats.retry}, hỏng ${stats.dead}`);
      const periodic = await runPeriodic();
      await heartbeat({ ...stats, periodic });
    } catch (error) {
      console.error("[worker] lỗi vòng xử lý:", (error as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await closePool();
  console.log("[worker] đã dừng");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

await loop();
