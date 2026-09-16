import { z } from "zod";
import { withTx } from "@/lib/db";
import { AppError, forbidden, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/http";
import { type Actor, can } from "@/modules/auth/actor";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";

/** Thao tác ghi trên connector (ngoài nhận sự kiện — việc đó ở ingest.ts). */

export function canPauseConnector(actor: Actor) {
  return can(actor, "connector.manage") || can(actor, "automation.pause");
}

const pauseInput = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(500).optional().nullable(),
});

/** Tạm dừng / tiếp tục nhận sự kiện của một connector (ingest từ chối khi paused). */
export async function setConnectorPaused(actor: Actor, connectorId: string, raw: unknown) {
  if (!canPauseConnector(actor)) throw forbidden();
  if (!isUuid(connectorId)) throw notFound("connector");
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
