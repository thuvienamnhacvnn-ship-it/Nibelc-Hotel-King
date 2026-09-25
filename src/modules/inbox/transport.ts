import { queryOne } from "@/lib/db";
import { SEND_LIMITS } from "./limits";

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

export const SEND_INTERVAL_MS = SEND_LIMITS.intervalMs;
const SEND_TIMEOUT_MS = 15_000;
const MAX_TEXT = 4000;
const DEFAULT_MAX_WAIT_MS = 15_000;

/**
 * Các lần gửi được tính vào trần giờ của một connector, mỗi dòng một mốc thời gian (dùng chung cho đếm và tính lượt kế tiếp).
 * Tin hộp thư: đã gửi (sent_at), đang gửi / lỗi "không rõ" (locked_at). Thông báo đội (migration 0008 có connector_id):
 * đã gửi (sent_at), đang gửi (locked_at). Tin đang gửi — kể cả tin hiện tại — được tính ⇒ trần không bao giờ bị vượt.
 * Tham số: $1 connector, $2 org.
 */
const HOUR_EVENTS = `
  SELECT coalesce(m.sent_at, m.locked_at) AS at FROM messages m
   WHERE m.connector_id = $1 AND m.org_id = $2 AND m.direction = 'out'
     AND (m.sent_at > now() - interval '60 minutes'
          OR (m.sent_at IS NULL AND m.locked_at > now() - interval '60 minutes'
              AND (m.status = 'sending' OR (m.status = 'failed' AND m.error LIKE 'uncertain%'))))
  UNION ALL
  SELECT coalesce(s.sent_at, s.locked_at) FROM staff_notifications s
   WHERE s.connector_id = $1 AND s.org_id = $2
     AND (s.sent_at > now() - interval '60 minutes' OR (s.status = 'sending' AND s.locked_at > now() - interval '60 minutes'))`;

/**
 * Giành một lượt gửi cho connector — tính theo DB nên đúng cả khi web, worker và nhiều tiến trình cùng gửi.
 * NƠI DUY NHẤT mọi đường gửi WhatsApp (hộp thư, thông báo đội) đi qua. Một câu UPDATE nguyên tử trên dòng connector:
 *   - cách lần gửi trước ≥ SEND_LIMITS.intervalMs (`connector_accounts.last_send_at`) và không có tin hộp thư vừa `sent`;
 *   - số lần gửi trong 60 phút (HOUR_EVENTS, cả hai bảng theo connector_id) < SEND_LIMITS.connectorPerHour.
 * Dòng connector bị khoá khi UPDATE nên hai tiến trình không cùng lọt qua một chỗ trống.
 */
export async function reserveSendSlot(orgId: string, connectorId: string): Promise<"ok" | "interval" | "hour"> {
  const row = await queryOne<{ id: string }>(
    `UPDATE connector_accounts SET last_send_at = now()
      WHERE id = $1 AND org_id = $2 AND (last_send_at IS NULL OR last_send_at <= now() - make_interval(secs => $3))
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.connector_id = $1 AND m.org_id = $2 AND m.sent_at > now() - make_interval(secs => $3))
        AND (SELECT count(*) FROM (${HOUR_EVENTS}) e) < $4
      RETURNING id`,
    [connectorId, orgId, SEND_LIMITS.intervalMs / 1000, SEND_LIMITS.connectorPerHour],
  );
  if (row) return "ok";
  const over = await queryOne<{ over: boolean }>(`SELECT (SELECT count(*) FROM (${HOUR_EVENTS}) e) >= $3 AS over`, [connectorId, orgId, SEND_LIMITS.connectorPerHour]);
  return over?.over ? "hour" : "interval";
}

/**
 * Lúc sớm nhất connector có lại chỗ trong trần giờ: mốc của lần gửi thứ (n − cap + 1) cũ nhất + 60 phút.
 * Dùng để hoãn tin (available_at) thay vì thử lại mỗi vòng. Chưa chạm trần ⇒ now().
 */
export async function nextHourSlotAt(orgId: string, connectorId: string): Promise<Date> {
  const row = await queryOne<{ at: Date }>(
    `SELECT coalesce(
        (SELECT at + interval '60 minutes' FROM (${HOUR_EVENTS}) e ORDER BY at DESC OFFSET ($3::int - 1) LIMIT 1),
        now()) AS at`,
    [connectorId, orgId, SEND_LIMITS.connectorPerHour],
  );
  return row?.at ?? new Date();
}

/**
 * Người nhận cho Evolution: jid cá nhân `@s.whatsapp.net` → số; jid nhóm `@g.us` và jid ẩn danh `@lid` giữ NGUYÊN VĂN.
 * `@lid` là mã ẩn danh của WhatsApp, KHÔNG phải số điện thoại — không bao giờ suy ra số từ nó. Hậu tố lạ ⇒ null.
 */
export function toEvolutionNumber(toJidOrPhone: string): string | null {
  const v = toJidOrPhone.trim();
  if (v.endsWith("@g.us")) return /^[\d-]+@g\.us$/.test(v) ? v : null;
  if (v.endsWith("@lid")) return /^\d+(:\d+)?@lid$/.test(v) ? v : null;
  if (v.includes("@") && !v.endsWith("@s.whatsapp.net")) return null;
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
  for (;;) {
    const slot = await reserveSendSlot(orgId, connectorId);
    if (slot === "ok") break;
    // Vượt trần giờ: không đứng chờ — người gọi trả tin về hàng đợi.
    if (slot === "hour") return { ok: false, reason: "rate_limited_hour" };
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

/** Đường gọi Evolution của một connector; thiếu cấu hình thì trả null. */
async function evolutionEndpoint(orgId: string, connectorId: string) {
  const connector = await queryOne<{ channel: string; status: string; config: Record<string, unknown> | null }>(
    "SELECT channel, status, config FROM connector_accounts WHERE id = $1 AND org_id = $2",
    [connectorId, orgId],
  );
  if (!connector || connector.channel !== "whatsapp" || connector.status === "demo" || connector.status === "not_configured") return null;
  const cfg = connector.config ?? {};
  const baseUrl = (typeof cfg.evolutionApiUrl === "string" && cfg.evolutionApiUrl) || process.env.EVOLUTION_API_URL || "";
  const instance = (typeof cfg.evolutionInstance === "string" && cfg.evolutionInstance) || process.env.EVOLUTION_INSTANCE || "";
  const apiKey = process.env.EVOLUTION_API_KEY || "";
  if (!baseUrl || !instance || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), instance, apiKey };
}

export const MEDIA_FETCH_TIMEOUT_MS = 30_000;

export type MediaResult = { ok: true; base64: string } | { ok: false; reason: string };

/**
 * Lấy nội dung ảnh/clip của một tin vừa nhận.
 *
 * PHẢI gửi cả object tin (`key` + `message`), không phải mỗi mã tin: Evolution chỉ đi tra kho lịch sử
 * khi thiếu phần `message`, mà kho đó không bật nên tra là "Message not found" (đã dính 19/09).
 * Có đủ object thì nó giải mã thẳng từ `url` + `mediaKey` trong payload, không cần lịch sử.
 *
 * Bật `webhookBase64` KHÔNG đủ: bản 2.3.7 vẫn không kèm nội dung vào webhook (đã đo 25/09).
 */
export async function fetchMediaBase64(orgId: string, connectorId: string, rawMessage: unknown): Promise<MediaResult> {
  const ep = await evolutionEndpoint(orgId, connectorId);
  if (!ep) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(`${ep.baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(ep.instance)}`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: ep.apiKey },
      body: JSON.stringify({ message: rawMessage, convertToMp4: false }),
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const json = (await res.json().catch(() => null)) as { base64?: unknown } | null;
    const b64 = json?.base64;
    return typeof b64 === "string" && b64.length > 0 ? { ok: true, base64: b64 } : { ok: false, reason: "khong_co_base64" };
  } catch (error) {
    return { ok: false, reason: (error as Error)?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
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
  rate_limited_hour: "Đã chạm trần tin/giờ của số tổng đài — chờ lượt sau",
  expired: "Quá hạn gửi — xem lại trước khi gửi lại",
  taken_over: "Người đã tiếp quản hội thoại — bot không gửi",
  bot_conversation_limit: "Bot đã trả lời nhiều trong hội thoại — chuyển người",
  uncertain: "Không rõ đã gửi hay chưa — kiểm trên điện thoại trước khi gửi lại",
  no_connector: "Hội thoại không gắn connector",
};

export function sendFailureLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  const [code, ...rest] = reason.split(":");
  const base = SEND_FAILURE_LABELS[code] ?? (code.startsWith("http_") ? `Evolution trả lỗi HTTP ${code.slice(5)}` : code);
  return rest.length ? `${base}: ${rest.join(":").trim()}` : base;
}
