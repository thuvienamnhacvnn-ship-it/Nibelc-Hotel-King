import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { AppError } from "./errors";
import type { Actor } from "@/modules/auth/actor";
import { SESSION_COOKIE, actorFromToken } from "@/modules/auth/sessions";

/**
 * Chuẩn API /api/v1:
 *   - Thành công: JSON dữ liệu trực tiếp (object hoặc { items, page, pageSize, total }).
 *   - Lỗi: { error: { code, message, details? } } + HTTP status (401/403/404/409/422/500).
 *   - Xác thực bằng cookie phiên; request ghi (POST/PATCH/PUT/DELETE) phải cùng origin (chống CSRF).
 */

export function jsonError(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

function clientIp(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function toErrorResponse(error: unknown) {
  if (error instanceof AppError) return jsonError(error.status, error.code, error.message, error.details);
  if (error instanceof ZodError) {
    return jsonError(
      422,
      "invalid_input",
      error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
      error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  console.error("[api] lỗi không mong đợi:", error);
  return jsonError(500, "internal_error", "Lỗi hệ thống. Thử lại sau hoặc báo quản trị.");
}

type Ctx<P> = { params: Promise<P> };

/** Bọc route handler: xác thực, chống CSRF, chuẩn hoá lỗi. */
export function api<P = Record<string, string>>(
  handler: (req: NextRequest, actor: Actor, params: P) => Promise<unknown>,
  opts: { public?: false } = {},
) {
  void opts;
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
        return jsonError(403, "cross_origin", "Yêu cầu từ nguồn khác bị chặn.");
      }
      const actor = await actorFromToken(req.cookies.get(SESSION_COOKIE)?.value, clientIp(req));
      if (!actor) return jsonError(401, "unauthenticated", "Phiên đăng nhập đã hết. Đăng nhập lại.");
      const params = (await ctx.params) as P;
      const result = await handler(req, actor, params);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new AppError("invalid_json", "Body không phải JSON hợp lệ.", 400);
  }
}

export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function pageParams(url: URL, defaults = { pageSize: 50, max: 200 }): PageParams {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(defaults.max, Math.max(1, Number(url.searchParams.get("pageSize") ?? defaults.pageSize) || defaults.pageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
