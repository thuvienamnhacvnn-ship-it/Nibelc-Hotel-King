/**
 * Worker nền: xử lý outbox (lập việc dọn khi booking đổi, ...).
 * Chạy: `npm run worker` (giữ mở cạnh `npm run dev`). Web vẫn chạy được khi worker tắt — việc chỉ chậm cập nhật,
 * và màn hình Tổng quan hiện số sự kiện đang chờ để người vận hành biết.
 */
import { loadLocalEnv } from "@/lib/env";

loadLocalEnv();

const { closePool, query } = await import("@/lib/db");
const { drainOutbox } = await import("@/modules/outbox/outbox");
const { handlers } = await import("./handlers");

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
let stopping = false;

async function heartbeat(stats: Record<string, number>) {
  await query(
    `INSERT INTO system_heartbeats (name, last_beat_at, detail) VALUES ('worker', now(), $1)
     ON CONFLICT (name) DO UPDATE SET last_beat_at = now(), detail = EXCLUDED.detail`,
    [JSON.stringify({ pid: process.pid, ...stats })],
  );
}

async function loop() {
  console.log(`[worker] bắt đầu, nhịp ${POLL_MS}ms`);
  while (!stopping) {
    try {
      const stats = await drainOutbox(handlers, 10);
      if (stats.done || stats.retry || stats.dead) console.log(`[worker] xong ${stats.done}, thử lại ${stats.retry}, hỏng ${stats.dead}`);
      await heartbeat(stats);
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
