import { z } from "zod";
import { query, queryOne, withTx } from "@/lib/db";
import { AppError, forbidden, notFound } from "@/lib/errors";
import type { PageParams } from "@/lib/http";
import { type Actor, can } from "@/modules/auth/actor";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";

/** Màn hình Kết nối: bảng connector, nhật ký sự kiện nhận. Không hiển thị payload (có tên khách). */

export const INBOUND_STATUSES = ["received", "applied", "duplicate", "stale", "needs_reconcile", "conflict", "failed"] as const;

export const INBOUND_STATUS_LABELS: Record<string, string> = {
  received: "Đã nhận — chưa xử lý",
  applied: "Đã áp dụng",
  duplicate: "Trùng (gửi lại)",
  stale: "Cũ hơn dữ liệu đang lưu",
  needs_reconcile: "Cần đối soát nguồn",
  conflict: "Xung đột tồn",
  failed: "Lỗi",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectorRow {
  id: string;
  channel: string;
  label: string;
  status: string;
  capabilities: Record<string, boolean>;
  note: string | null;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  paused: boolean;
  updated_at: Date;
  events_24h: number;
  failed_24h: number;
}

export async function listConnectors(actor: Actor) {
  return query<ConnectorRow>(
    `SELECT c.id, c.channel, c.label, c.status, c.capabilities, c.config->>'note' AS note, c.last_attempt_at, c.last_success_at, c.last_error, c.paused, c.updated_at,
            (SELECT count(*)::int FROM inbound_events e WHERE e.connector_id = c.id AND e.org_id = $1 AND e.received_at > now() - interval '24 hours') AS events_24h,
            (SELECT count(*)::int FROM inbound_events e WHERE e.connector_id = c.id AND e.org_id = $1 AND e.received_at > now() - interval '24 hours' AND e.status = 'failed') AS failed_24h
       FROM connector_accounts c WHERE c.org_id = $1
      ORDER BY c.status = 'not_configured', c.label`,
    [actor.orgId],
  );
}

export interface InboundEventRow {
  id: string;
  connector_id: string;
  connector_label: string;
  connector_status: string;
  external_event_id: string;
  external_ref: string | null;
  event_type: string;
  source_version: number | null;
  source_occurred_at: Date | null;
  received_at: Date;
  processed_at: Date | null;
  status: string;
  message: string | null;
  booking_id: string | null;
  booking_ref: string | null;
  /** nguồn phát sinh → backend nhận (ms); null khi nguồn không gửi thời điểm */
  source_to_received_ms: number | null;
  /** backend nhận → xử lý xong (ms) */
  received_to_processed_ms: number | null;
}

export async function listInboundEvents(actor: Actor, filter: { connectorId?: string | null; status?: string | null }, page: PageParams) {
  const connectorId = filter.connectorId && UUID_RE.test(filter.connectorId) ? filter.connectorId : null;
  const status = filter.status && (INBOUND_STATUSES as readonly string[]).includes(filter.status) ? filter.status : null;
  const params = [actor.orgId, connectorId, status];
  const where = "e.org_id = $1 AND ($2::uuid IS NULL OR e.connector_id = $2::uuid) AND ($3::text IS NULL OR e.status = $3::text)";
  const [items, total] = await Promise.all([
    query<InboundEventRow>(
      `SELECT e.id, e.connector_id, c.label AS connector_label, c.status AS connector_status, e.external_event_id, e.external_ref, e.event_type, e.source_version,
              e.source_occurred_at, e.received_at, e.processed_at, e.status, e.result->>'message' AS message, e.booking_id, b.external_ref AS booking_ref,
              (extract(epoch FROM (e.received_at - e.source_occurred_at)) * 1000)::bigint AS source_to_received_ms,
              (extract(epoch FROM (e.processed_at - e.received_at)) * 1000)::bigint AS received_to_processed_ms
         FROM inbound_events e
         JOIN connector_accounts c ON c.id = e.connector_id AND c.org_id = $1
         LEFT JOIN bookings b ON b.id = e.booking_id AND b.org_id = $1
        WHERE ${where}
        ORDER BY e.received_at DESC, e.id
        LIMIT $4 OFFSET $5`,
      [...params, page.pageSize, page.offset],
    ),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM inbound_events e WHERE ${where}`, params),
  ]);
  return { items, page: page.page, pageSize: page.pageSize, total: total?.n ?? 0 };
}

export function canPauseConnector(actor: Actor) {
  return can(actor, "connector.manage") || can(actor, "automation.pause");
}

const pauseInput = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(500).optional().nullable(),
});

/**
 * Tạm dừng / tiếp tục nhận sự kiện của một connector (ingest từ chối khi paused).
 * Ghi ở đây vì chỉ đổi một cờ vận hành; đề xuất chuyển sang connectors/service.ts khi có module đó.
 */
export async function setConnectorPaused(actor: Actor, connectorId: string, raw: unknown) {
  if (!canPauseConnector(actor)) throw forbidden();
  if (!UUID_RE.test(connectorId)) throw notFound("connector");
  const input = pauseInput.parse(raw);
  if (input.paused && (input.reason ?? "").length < 3) throw new AppError("invalid_input", "Cần lý do tạm dừng (ít nhất 3 ký tự).", 422);
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; label: string; paused: boolean }>("SELECT id, label, paused FROM connector_accounts WHERE id = $1 AND org_id = $2 FOR UPDATE", [
      connectorId,
      actor.orgId,
    ]);
    const connector = rows[0];
    if (!connector) throw notFound("connector");
    if (connector.paused === input.paused) {
      throw new AppError("no_change", input.paused ? "Connector đã đang tạm dừng." : "Connector đang chạy, không cần tiếp tục.", 409);
    }
    await tx.query("UPDATE connector_accounts SET paused = $3, updated_at = now() WHERE id = $1 AND org_id = $2", [connectorId, actor.orgId, input.paused]);
    await writeAudit(tx, auditActorOf(actor), input.paused ? "connector.pause" : "connector.resume", "connector", connectorId, {
      label: connector.label,
      reason: input.reason ?? null,
    });
    return { ok: true, paused: input.paused };
  });
}
