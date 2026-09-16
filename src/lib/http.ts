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
  // Không có Origin thì phải có Sec-Fetch-Site cùng nguồn — thiếu cả hai coi như không tin được.
  if (!origin) return ["same-origin", "none"].includes(req.headers.get("sec-fetch-site") ?? "");
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
      if (/%00/i.test(req.nextUrl.search) || req.nextUrl.search.includes("\u0000")) {
        return jsonError(400, "invalid_characters", "Tham số chứa ký tự không hợp lệ.");
      }
      const actor = await actorFromToken(req.cookies.get(SESSION_COOKIE)?.value, clientIp(req));
      if (!actor) return jsonError(401, "unauthenticated", "Phiên đăng nhập đã hết. Đăng nhập lại.");
      const params = (await ctx.params) as P;
      // Tham số đường dẫn tên "id" hoặc "...Id" phải là UUID — sai dạng thì 404, không để SQL báo lỗi.
      for (const [key, value] of Object.entries((params ?? {}) as Record<string, unknown>)) {
        if ((key === "id" || key.endsWith("Id")) && !isUuid(value)) return jsonError(404, "not_found", "Không tìm thấy bản ghi.");
      }
      const result = await handler(req, actor, params);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export async function readJson(req: NextRequest): Promise<unknown> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new AppError("invalid_json", "Body không phải JSON hợp lệ.", 400);
  }
  // PostgreSQL không lưu được ký tự NUL trong text — từ chối sớm thay vì để lỗi 500 ở tầng DB.
  if (text.includes("\u0000") || /\\u0000/i.test(text)) throw new AppError("invalid_characters", "Dữ liệu chứa ký tự không hợp lệ.", 400);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("invalid_json", "Body không phải JSON hợp lệ.", 400);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Id trong đường dẫn không đúng dạng thì trả 404 ngay, không chạy câu SQL sẽ lỗi. */
export function assertUuid(value: unknown, what = "bản ghi"): string {
  if (!isUuid(value)) throw new AppError("not_found", `Không tìm thấy ${what}.`, 404);
  return value;
}

export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function pageParams(url: URL, defaults = { pageSize: 50, max: 200 }): PageParams {
  const rawPage = Number(url.searchParams.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= 100_000 ? rawPage : 1;
  const pageSize = Math.min(defaults.max, Math.max(1, Number(url.searchParams.get("pageSize") ?? defaults.pageSize) || defaults.pageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
