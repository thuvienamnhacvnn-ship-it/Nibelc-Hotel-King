import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, logout } from "@/modules/auth/sessions";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await logout(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
