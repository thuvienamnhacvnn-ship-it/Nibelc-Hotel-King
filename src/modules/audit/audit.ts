import { type Queryable, pool } from "@/lib/db";
import type { Actor } from "@/modules/auth/actor";

export interface AuditActor {
  orgId: string;
  actorType: string;
  actorId: string | null;
  ip?: string | null;
}

export function auditActorOf(actor: Actor): AuditActor {
  return { orgId: actor.orgId, actorType: actor.kind, actorId: actor.userId, ip: actor.ip };
}

/** Khoá có thể chứa bí mật — không bao giờ ghi vào nhật ký. */
const SECRET_KEYS = /pass(word)?|token|secret|door_?code|access_?code|api_?key|authorization|cookie/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[đã ẩn]" : redactSecrets(v)]),
    );
  }
  return value;
}

export async function writeAudit(
  client: Queryable | null,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string | null,
  detail: Record<string, unknown>,
) {
  await (client ?? pool()).query(
    "INSERT INTO audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [actor.orgId, actor.actorType, actor.actorId, action, entityType, entityId, JSON.stringify(redactSecrets(detail)), actor.ip ?? null],
  );
}
