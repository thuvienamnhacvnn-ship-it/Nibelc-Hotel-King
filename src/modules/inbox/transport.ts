import { queryOne } from "@/lib/db";

/**
 * Gửi tin WhatsApp qua Evolution API v2 (`POST {url}/message/sendText/{instance}`, header `apikey`).
 *
 * Hàm này là đường gửi mức thấp — NGƯỜI GỌI phải kiểm công tắc `isPaused` và nội dung đã duyệt trước khi gọi.
 * Ở đây chỉ chặn những gì chắc chắn không được gửi: connector khác tổ chức / không phải WhatsApp / demo / tạm dừng,
 * thiếu cấu hình. Không bao giờ trả ok khi chưa có mã tin từ Evolution.
 *
 * Cấu hình: URL + instance lấy từ `connector_accounts.config` (`evolutionApiUrl`, `evolutionInstance`) hoặc env
 * `EVOLUTION_API_URL`, `EVOLUTION_INSTANCE`. Khoá API CHỈ lấy từ env `EVOLUTION_API_KEY` — config hiển thị trên giao diện.
 *
 * Giới hạn 1 tin / 3 giây mỗi connector, tính theo DB (reserveSendSlot): số tổng đài từng bị WhatsApp gỡ thiết bị sau đợt nhắn.
 */
export type SendResult = { ok: true; externalId: string } | { ok: false; reason: string };

export const SEND_INTERVAL_MS = 3000;
const SEND_TIMEOUT_MS = 15_000;
const MAX_TEXT = 4000;
const DEFAULT_MAX_WAIT_MS = 15_000;

/**
 * Giành một lượt gửi cho connector — tính theo DB nên đúng cả khi web, worker và nhiều tiến trình cùng gửi.
 * Một câu UPDATE nguyên tử: chỉ thành công khi lần thử gần nhất đã cách ít nhất SEND_INTERVAL_MS.
 * Mốc `connector_accounts.last_send_at` (migration 0007) dùng chung cho tin khách và thông báo đội — không cần khoá giữ trong lúc gọi mạng.
 * Thêm chốt phụ: không có tin hộp thư nào của connector vừa `sent` trong 3 giây (max(messages.sent_at)).
 */
export async function reserveSendSlot(orgId: string, connectorId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE connector_accounts SET last_send_at = now()
      WHERE id = $1 AND org_id = $2 AND (last_send_at IS NULL OR last_send_at <= now() - make_interval(secs => $3))
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.connector_id = $1 AND m.org_id = $2 AND m.sent_at > now() - make_interval(secs => $3))
      RETURNING id`,
    [connectorId, orgId, SEND_INTERVAL_MS / 1000],
  );
  return !!row;
}

/** jid cá nhân → số; jid nhóm giữ nguyên (Evolution nhận cả hai). */
export function toEvolutionNumber(toJidOrPhone: string): string | null {
  const v = toJidOrPhone.trim();
  if (v.endsWith("@g.us")) return /^[\d-]+@g\.us$/.test(v) ? v : null;
  const digits = v.replace(/@.*$/, "").replace(/\D/g, "").replace(/^00/, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/**
 * `opts.maxWaitMs`: chờ tối đa bao lâu để tới lượt gửi (mặc định 15 giây). Hết chờ ⇒ `rate_limited` — chắc chắn CHƯA gửi.
 * Worker hộp thư truyền 0 để không đứng chờ, tin giữ nguyên hàng đợi.
 */
export async function sendWhatsAppText(orgId: string, connectorId: string, toJidOrPhone: string, text: string, opts: { maxWaitMs?: number } = {}): Promise<SendResult> {
  const connector = await queryOne<{ channel: string; status: string; paused: boolean; config: Record<string, unknown> | null }>(
    "SELECT channel, status, paused, config FROM connector_accounts WHERE id = $1 AND org_id = $2",
    [connectorId, orgId],
  );
  if (!connector || connector.channel !== "whatsapp") return { ok: false, reason: "connector_not_found" };
  if (connector.status === "demo") return { ok: false, reason: "connector_demo" };
  if (connector.paused) return { ok: false, reason: "connector_paused" };
  const body = text.trim();
  if (!body) return { ok: false, reason: "empty_text" };
  if (body.length > MAX_TEXT) return { ok: false, reason: "text_too_long" };
  const number = toEvolutionNumber(toJidOrPhone);
  if (!number) return { ok: false, reason: "invalid_recipient" };

  const cfg = connector.config ?? {};
  const baseUrl = (typeof cfg.evolutionApiUrl === "string" && cfg.evolutionApiUrl) || process.env.EVOLUTION_API_URL || "";
  const instance = (typeof cfg.evolutionInstance === "string" && cfg.evolutionInstance) || process.env.EVOLUTION_INSTANCE || "";
  const apiKey = process.env.EVOLUTION_API_KEY || "";
  if (!baseUrl || !instance || !apiKey || connector.status === "not_configured") return { ok: false, reason: "not_configured" };

  const deadline = Date.now() + (opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  while (!(await reserveSendSlot(orgId, connectorId))) {
    if (Date.now() >= deadline) return { ok: false, reason: "rate_limited" };
    await new Promise((r) => setTimeout(r, 250));
  }

  let result: SendResult;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/message/sendText/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: apiKey },
      body: JSON.stringify({ number, text: body }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) result = { ok: false, reason: `http_${res.status}` };
    else {
      const json = (await res.json().catch(() => null)) as { key?: { id?: unknown } } | null;
      const id = json?.key?.id;
      result = typeof id === "string" && id ? { ok: true, externalId: id } : { ok: false, reason: "no_message_id" };
    }
  } catch (error) {
    result = { ok: false, reason: (error as Error)?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
  // Không ghi last_success_at/last_error: các cột đó thuộc bộ nhận sự kiện kênh. Kết quả gửi nằm ở bản ghi tin.
  return result;
}

/**
 * Lỗi mà yêu cầu CÓ THỂ đã tới Evolution (hết giờ, mất kết nối giữa chừng, 5xx, 2xx không mã tin):
 * không biết khách đã nhận hay chưa ⇒ không được tự gửi lại.
 */
export function isUncertainSendFailure(reason: string): boolean {
  return reason === "timeout" || reason === "network_error" || reason === "no_message_id" || /^http_5\d\d$/.test(reason);
}

export const UNCERTAIN_SEND_REASON = "uncertain";

export const SEND_FAILURE_LABELS: Record<string, string> = {
  not_configured: "Chưa cấu hình Evolution API (URL/instance/khoá)",
  connector_demo: "Connector demo — không gửi thật",
  connector_paused: "Connector đang tạm dừng",
  connector_not_found: "Không tìm thấy connector WhatsApp",
  empty_text: "Nội dung trống",
  text_too_long: "Nội dung quá dài",
  invalid_recipient: "Số/nhóm nhận không hợp lệ",
  no_message_id: "Evolution không trả mã tin — không coi là đã gửi",
  timeout: "Quá thời gian chờ Evolution",
  network_error: "Lỗi mạng khi gọi Evolution",
  switch_paused: "Công tắc gửi tin đang dừng",
  rate_limited: "Chưa tới lượt gửi (1 tin/3 giây mỗi connector)",
  uncertain: "Không rõ đã gửi hay chưa — kiểm trên điện thoại trước khi gửi lại",
  no_connector: "Hội thoại không gắn connector",
};

export function sendFailureLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  const [code, ...rest] = reason.split(":");
  const base = SEND_FAILURE_LABELS[code] ?? (code.startsWith("http_") ? `Evolution trả lỗi HTTP ${code.slice(5)}` : code);
  return rest.length ? `${base}: ${rest.join(":").trim()}` : base;
}
