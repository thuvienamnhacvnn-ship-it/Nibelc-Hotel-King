import { type NextRequest, NextResponse } from "next/server";
import { WEBHOOK_MAX_BYTES, handleEvolutionWebhook } from "@/modules/inbox/evolution";

/**
 * POST /api/v1/webhooks/evolution/:connectorId — webhook Evolution API v2 (messages.upsert, messages.update).
 * Không dùng wrapper api(): không có cookie; xác thực bằng header x-webhook-token (so băm sha256, an toàn thời gian)
 * TRƯỚC khi đọc body; body đọc theo luồng và cắt khi vượt giới hạn (kể cả gửi chunked không có content-length).
 * Không log nội dung tin.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ connectorId: string }> }) {
  try {
    const { connectorId } = await ctx.params;
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > WEBHOOK_MAX_BYTES) return NextResponse.json({ error: { code: "payload_too_large", message: "Payload quá lớn." } }, { status: 413 });
    const result = await handleEvolutionWebhook(connectorId, req.headers.get("x-webhook-token"), req.body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[webhook evolution] lỗi xử lý:", (error as Error)?.message);
    return NextResponse.json({ error: { code: "internal_error", message: "Lỗi hệ thống." } }, { status: 500 });
  }
}
