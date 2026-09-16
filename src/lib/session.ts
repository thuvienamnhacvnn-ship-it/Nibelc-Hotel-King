import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { type Actor, can } from "@/modules/auth/actor";
import type { Permission } from "@/modules/auth/permissions";
import { SESSION_COOKIE, actorFromToken } from "@/modules/auth/sessions";

/** Actor của request hiện tại (Server Component). Cache theo request. */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return actorFromToken(token, ip);
});

/** Bắt buộc đăng nhập; thiếu quyền thì chuyển tới trang "không đủ quyền" (kiểm ở server, không chỉ ẩn nút). */
export async function requireActor(permission?: Permission | Permission[]): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  if (permission) {
    const list = Array.isArray(permission) ? permission : [permission];
    if (!list.some((p) => can(actor, p))) redirect("/khong-du-quyen");
  }
  return actor;
}

export function assertFound<T>(value: T | null | undefined): T {
  if (value == null) notFound();
  return value;
}
