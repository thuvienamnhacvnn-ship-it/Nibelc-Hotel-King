import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readJson, toErrorResponse } from "@/lib/http";
import { SESSION_COOKIE, login } from "@/modules/auth/sessions";

const body = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) });

export async function POST(req: NextRequest) {
  try {
    const input = body.parse(await readJson(req));
    const session = await login(input.email, input.password, {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    });
    const res = NextResponse.json({ ok: true, redirectTo: session.role === "cleaner" ? "/m" : "/" });
    res.cookies.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "1",
      path: "/",
      expires: session.expires,
    });
    return res;
  } catch (error) {
    return toErrorResponse(error);
  }
}
