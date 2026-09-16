import os from "node:os";
import type pg from "pg";
import { type Queryable, pool, query } from "@/lib/db";

export interface OutboxInput {
  orgId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number | null;
  payload?: Record<string, unknown>;
  /** Cùng dedupe_key thì chỉ ghi một lần — chống gửi lặp khi sự kiện nguồn đến nhiều lần. */
  dedupeKey?: string | null;
}

/** Ghi sự kiện vào outbox TRONG cùng giao dịch với thay đổi nghiệp vụ. */
export async function emit(tx: Queryable, e: OutboxInput) {
  await tx.query(
    `INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, aggregate_version, payload, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
    [e.orgId, e.topic, e.aggregateType, e.aggregateId, e.aggregateVersion ?? null, JSON.stringify(e.payload ?? {}), e.dedupeKey ?? null],
  );
}

export interface OutboxEvent {
  id: string;
  org_id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type OutboxHandler = (event: OutboxEvent, tx: pg.PoolClient) => Promise<void>;

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const LEASE_SECONDS = 60;

/**
 * Nhận một lô sự kiện bằng lease (locked_until). Worker chết giữa chừng thì lease hết hạn và sự kiện được nhận lại.
 * Handler phải idempotent: có thể chạy lại cùng một sự kiện.
 */
export async function claimBatch(limit = 20): Promise<OutboxEvent[]> {
  return query<OutboxEvent>(
    `UPDATE outbox_events SET status = 'processing', locked_by = $1, locked_until = now() + make_interval(secs => $2), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE (status = 'pending' AND available_at <= now())
            OR (status = 'processing' AND locked_until < now())
         ORDER BY created_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING id, org_id, topic, aggregate_type, aggregate_id, aggregate_version, payload, attempts, max_attempts`,
    [WORKER_ID, LEASE_SECONDS, limit],
  );
}

export async function processEvent(event: OutboxEvent, handlers: Record<string, OutboxHandler>): Promise<"done" | "retry" | "dead"> {
  const handler = handlers[event.topic];
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    if (handler) await handler(event, client);
    await client.query("UPDATE outbox_events SET status = 'done', processed_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1", [event.id]);
    await client.query("COMMIT");
    return "done";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message = (error as Error).message?.slice(0, 1000) ?? String(error);
    const dead = event.attempts >= event.max_attempts;
    // Lùi thời gian thử lại theo cấp số nhân, tối đa 30 phút.
    const backoffSeconds = Math.min(30 * 60, 15 * 2 ** (event.attempts - 1));
    await pool().query(
      `UPDATE outbox_events SET status = $2, last_error = $3, locked_until = NULL,
              available_at = now() + make_interval(secs => $4) WHERE id = $1`,
      [event.id, dead ? "dead" : "pending", message, backoffSeconds],
    );
    return dead ? "dead" : "retry";
  } finally {
    client.release();
  }
}

/** Chạy hết sự kiện đang chờ (dùng trong worker và kiểm thử). */
export async function drainOutbox(handlers: Record<string, OutboxHandler>, maxRounds = 50) {
  const stats = { done: 0, retry: 0, dead: 0 };
  for (let round = 0; round < maxRounds; round++) {
    const batch = await claimBatch();
    if (batch.length === 0) break;
    for (const event of batch) stats[await processEvent(event, handlers)] += 1;
  }
  return stats;
}
