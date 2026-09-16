import { forbidden } from "@/lib/errors";
import { type Permission, type Role, permissionsFor } from "./permissions";

/** Người (hoặc hệ thống) đang thực hiện hành động. Mọi service nhận actor tường minh. */
export interface Actor {
  kind: "user" | "system" | "connector" | "import" | "agent";
  userId: string | null;
  orgId: string;
  role: Role | null;
  fullName: string;
  timezone: string;
  permissions: ReadonlySet<Permission>;
  ip?: string | null;
}

export function userActor(input: { userId: string; orgId: string; role: Role; fullName: string; timezone: string; ip?: string | null }): Actor {
  return { kind: "user", ...input, permissions: permissionsFor(input.role) };
}

/** Tác nhân hệ thống (worker/connector) chỉ được cấp đúng quyền cần dùng. */
export function systemActor(orgId: string, kind: Actor["kind"], permissions: Permission[], timezone = "Europe/Budapest"): Actor {
  return { kind, userId: null, orgId, role: null, fullName: `system:${kind}`, timezone, permissions: new Set(permissions) };
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.permissions.has(permission);
}

export function assertCan(actor: Actor, permission: Permission, message?: string) {
  if (!can(actor, permission)) throw forbidden(message);
}

export function actorTypeForLog(actor: Actor): "user" | "system" | "connector" | "import" | "agent" {
  return actor.kind;
}
