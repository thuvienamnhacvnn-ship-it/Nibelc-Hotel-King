import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/http";
import { SESSION_COOKIE, logout } from "@/modules/auth/sessions";

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) {
    return jsonError(403, "cross_origin", "Yêu cầu từ nguồn khác bị chặn.");
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await logout(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
