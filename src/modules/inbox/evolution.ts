import crypto from "node:crypto";
import { query, queryOne } from "@/lib/db";
import { type InboundMessage, type InboxDeps, ingestInboundMessage } from "./service";
import { fetchMediaBase64 } from "./transport";

/**
 * Webhook Evolution API v2. Payload là dữ liệu KHÔNG tin cậy: giới hạn kích thước, chỉ bóc trường cần,
 * không log nội dung tin. Xác thực bằng header `x-webhook-token` so với băm sha256 lưu ở connector.
 */

/**
 * Bật `webhookBase64` thì nội dung ảnh/clip nằm ngay trong payload, mã base64 phình khoảng 4/3 lần:
 * tệp 16 MB thành ~21,4 MB. Để 256 KB như lúc chỉ nhận chữ là mọi tấm ảnh đều bị chặn.
 * Mở rộng vẫn an toàn vì token được kiểm TRƯỚC khi đọc body — người lạ không đẩy được payload lớn vào đây.
 */
export const WEBHOOK_MAX_BYTES = 24 * 1024 * 1024;

export function hashWebhookToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateWebhookToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** So sánh an toàn thời gian: băm token nhận được rồi so hai chuỗi băm cùng độ dài. */
export function tokenMatches(token: string | null | undefined, storedHash: string | null | undefined): boolean {
  if (!token || !storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashWebhookToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function normalizeEvent(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase().replace(/_/g, ".") : "";
}

/**
 * Bóc chữ và mô tả tệp. Nội dung nhị phân chỉ có khi instance bật `webhookBase64` — Evolution
 * đặt nó ở `data.message.base64` (bản khác để ở `data.base64`), nên nhận cả hai chỗ.
 * Không bật thì vẫn ghi nhận là có tệp, chỉ thiếu nội dung.
 */
function extractContent(message: Json | null, outer: Json | null): { text: string | null; attachments: ParsedAttachment[] } {
  if (!message) return { text: null, attachments: [] };
  const ext = obj(message.extendedTextMessage);
  const text = str(message.conversation) ?? str(ext?.text) ?? null;
  const base64 = str(message.base64) ?? str(outer?.base64) ?? null;
  const attachments: ParsedAttachment[] = [];
  let caption: string | null = null;
  for (const [key, kind] of [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["documentWithCaptionMessage", "document"],
    ["stickerMessage", "sticker"],
    ["locationMessage", "location"],
  ] as const) {
    let m = obj(message[key]);
    // Tệp kèm lời nhắn bọc thêm một lớp: documentWithCaptionMessage.message.documentMessage
    if (m && key === "documentWithCaptionMessage") m = obj(obj(m.message)?.documentMessage) ?? m;
    if (!m) continue;
    // Vị trí không phải tệp: không có gì để tải.
    const hasFile = kind !== "location";
    attachments.push({
      kind,
      mimeType: hasFile ? str(m.mimetype) : null,
      fileName: hasFile ? str(m.fileName) ?? str(m.title) : null,
      // Một tin chỉ mang một tệp, nên base64 của tin thuộc về tệp đó.
      base64: hasFile ? base64 : null,
    });
    caption = caption ?? str(m.caption);
  }
  return { text: text ?? caption, attachments };
}

export interface ParsedAttachment {
  kind: string;
  mimeType: string | null;
  fileName: string | null;
  /** Nội dung tệp dạng base64; webhook không kèm thì lấy sau bằng `fetchMediaBase64`. */
  base64: string | null;
  /** Vì sao hỏi Evolution mà không lấy được nội dung. */
  fetchError?: string;
}

export interface ParsedUpsert {
  threadId: string;
  externalMessageId: string;
  senderHandle: string | null;
  senderName: string | null;
  text: string | null;
  attachments: ParsedAttachment[];
  occurredAt: Date | null;
  /** Object tin gốc — cần nguyên vẹn để nhờ Evolution giải mã tệp (xem `fetchMediaBase64`). */
  raw: unknown;
}

export interface ParsedStatus {
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
}

export function parseEvolutionPayload(payload: unknown): { event: string; upserts: ParsedUpsert[]; statuses: ParsedStatus[]; ignored: number } {
  const root = obj(payload);
  const event = normalizeEvent(root?.event);
  const items = Array.isArray(root?.data) ? (root!.data as unknown[]) : root?.data ? [root.data] : [];
  const upserts: ParsedUpsert[] = [];
  const statuses: ParsedStatus[] = [];
  let ignored = 0;
  for (const raw of items.slice(0, 50)) {
    const d = obj(raw);
    if (!d) {
      ignored++;
      continue;
    }
    if (event === "messages.upsert") {
      const key = obj(d.key);
      const remoteJid = str(key?.remoteJid);
      const id = str(key?.id);
      if (!remoteJid || !id || key?.fromMe === true || remoteJid === "status@broadcast" || remoteJid.endsWith("@broadcast") || remoteJid.endsWith("@newsletter")) {
        ignored++;
        continue;
      }
      const content = extractContent(obj(d.message), d);
      const ts = Number(d.messageTimestamp);
      upserts.push({
        threadId: remoteJid,
        externalMessageId: id,
        senderHandle: remoteJid.endsWith("@g.us") ? str(key?.participant) ?? str(d.participant) : remoteJid,
        senderName: str(d.pushName)?.slice(0, 200) ?? null,
        text: content.text,
        attachments: content.attachments,
        occurredAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null,
        raw: d,
      });
    } else if (event === "messages.update") {
      const id = str(d.keyId) ?? str(obj(d.key)?.id) ?? str(d.messageId);
      const s = String(d.status ?? obj(d.update)?.status ?? "").toUpperCase();
      const mapped = s === "SERVER_ACK" ? "sent" : s === "DELIVERY_ACK" ? "delivered" : s === "READ" || s === "PLAYED" ? "read" : s === "ERROR" ? "failed" : null;
      if (!id || !mapped) {
        ignored++;
        continue;
      }
      statuses.push({ externalMessageId: id, status: mapped });
    } else ignored++;
  }
  return { event, upserts, statuses, ignored };
}

const STATUS_RANK: Record<string, string[]> = {
  // trạng thái mới → những trạng thái hiện tại được phép nâng lên (không bao giờ hạ)
  sent: ["sending"],
  delivered: ["sent"],
  read: ["sent", "delivered"],
  failed: ["sent"],
};

export async function applyDeliveryStatus(orgId: string, connectorId: string, s: ParsedStatus): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE messages m SET status = $4::text, error = CASE WHEN $4::text = 'failed' THEN 'Kênh báo lỗi gửi' ELSE m.error END
       FROM conversations c
      WHERE c.id = m.conversation_id AND c.org_id = $1 AND c.connector_id = $2 AND m.org_id = $1
        AND m.direction = 'out' AND m.external_message_id = $3 AND m.status = ANY($5::text[])
      RETURNING m.id`,
    [orgId, connectorId, s.externalMessageId, s.status, STATUS_RANK[s.status]],
  );
  return rows.length;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookConnector {
  id: string;
  org_id: string;
  is_demo: boolean;
}

const UNAUTHORIZED: WebhookResult = { status: 401, body: { error: { code: "unauthorized", message: "Token webhook không hợp lệ." } } };
const TOO_LARGE: WebhookResult = { status: 413, body: { error: { code: "payload_too_large", message: "Payload quá lớn." } } };

/** Bước 1 — chỉ cần header: xác thực TRƯỚC khi đọc body. Không phân biệt "không có connector" với "sai token". */
export async function authenticateEvolutionWebhook(connectorId: string, token: string | null): Promise<WebhookConnector | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectorId)) return null;
  if (!token) return null;
  const connector = await queryOne<{ id: string; org_id: string; channel: string; webhook_secret_hash: string | null; is_demo: boolean }>(
    `SELECT ca.id, ca.org_id, ca.channel, ca.webhook_secret_hash, o.is_demo
       FROM connector_accounts ca JOIN organizations o ON o.id = ca.org_id WHERE ca.id = $1`,
    [connectorId],
  );
  if (!connector || connector.channel !== "whatsapp" || !tokenMatches(token, connector.webhook_secret_hash)) return null;
  return { id: connector.id, org_id: connector.org_id, is_demo: connector.is_demo };
}

/** Bước 2 — đọc body theo luồng, dừng ngay khi vượt WEBHOOK_MAX_BYTES (không tin content-length, kể cả chunked). */
export async function readLimitedBody(stream: ReadableStream<Uint8Array> | null, max = WEBHOOK_MAX_BYTES): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!stream) return { ok: true, text: "" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)) };
}

/**
 * Bản đồ TÊN TRƯỜNG của payload — chỉ tên, không bao giờ kèm giá trị, để dò xem nhà cung cấp
 * đặt nội dung tệp ở đâu mà không làm lộ nội dung tin. Chuỗi dài chỉ ghi độ dài.
 */
function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (typeof value === "object") {
    if (depth > 4) return "{...}";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shapeOf(v, depth + 1);
    return out;
  }
  if (typeof value === "string") return value.length > 40 ? `<chuoi ${value.length}>` : "<chuoi>";
  return `<${typeof value}>`;
}

/**
 * Webhook chỉ mang mô tả tệp (url + mediaKey), không mang nội dung — kể cả khi đã bật `webhookBase64`
 * (đo trên Evolution 2.3.7 ngày 25/09). Nên phải hỏi lại ngay lúc này: URL trên CDN của WhatsApp có
 * hạn, để lát nữa mới lấy là mất. Lấy hỏng thì vẫn cho tin nhắn đi tiếp, chỉ ghi lý do.
 */
async function fillMissingMedia(connector: WebhookConnector, u: ParsedUpsert, deps?: Partial<InboxDeps>) {
  const need = u.attachments.some((a) => a.kind !== "location" && !a.base64);
  if (!need) return;
  const fetchMedia = deps?.fetchMedia ?? fetchMediaBase64;
  const res = await fetchMedia(connector.org_id, connector.id, u.raw);
  if (!res.ok) {
    for (const a of u.attachments) if (a.kind !== "location" && !a.base64) a.fetchError = res.reason;
    return;
  }
  // Một tin WhatsApp chỉ mang một tệp, nên nội dung trả về thuộc về tệp đang thiếu.
  const target = u.attachments.find((a) => a.kind !== "location" && !a.base64);
  if (target) target.base64 = res.base64;
}

/** Bước 3 — xử lý payload của connector đã xác thực. */
export async function processEvolutionPayload(connector: WebhookConnector, rawBody: string, deps?: Partial<InboxDeps>): Promise<WebhookResult> {
  if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_MAX_BYTES) return TOO_LARGE;
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: { code: "invalid_json", message: "Body không phải JSON hợp lệ." } } };
  }
  const parsed = parseEvolutionPayload(payload);
  // Có tệp mà không có nội dung: ghi lại bản đồ trường để biết nhà cung cấp để base64 ở đâu.
  // Bật bằng env INBOX_DEBUG_SHAPE=1, chỉ dùng lúc dò, và không bao giờ in giá trị.
  if (process.env.INBOX_DEBUG_SHAPE === "1" && parsed.upserts.some((u) => u.attachments.some((a) => a.kind !== "location" && !a.base64))) {
    console.warn("[webhook evolution] tep khong co noi dung — ban do truong:", JSON.stringify(shapeOf(payload)));
  }
  let stored = 0;
  let duplicates = 0;
  let statusUpdates = 0;
  for (const u of parsed.upserts) {
    await fillMissingMedia(connector, u, deps);
    const { raw: _raw, ...rest } = u;
    const input: InboundMessage = { orgId: connector.org_id, connectorId: connector.id, channel: "whatsapp", ...rest, isDemo: connector.is_demo };
    const res = await ingestInboundMessage(input, deps);
    if (res.status === "duplicate") duplicates++;
    else stored++;
  }
  for (const s of parsed.statuses) statusUpdates += await applyDeliveryStatus(connector.org_id, connector.id, s);
  return { status: 200, body: { ok: true, event: parsed.event || null, stored, duplicates, statusUpdates, ignored: parsed.ignored } };
}

/** Gộp 3 bước (dùng trong kiểm thử và route). */
export async function handleEvolutionWebhook(
  connectorId: string,
  token: string | null,
  body: string | ReadableStream<Uint8Array> | null,
  deps?: Partial<InboxDeps>,
): Promise<WebhookResult> {
  const connector = await authenticateEvolutionWebhook(connectorId, token);
  if (!connector) return UNAUTHORIZED;
  let raw: string;
  if (typeof body === "string") raw = body;
  else {
    const read = await readLimitedBody(body);
    if (!read.ok) return TOO_LARGE;
    raw = read.text;
  }
  return processEvolutionPayload(connector, raw, deps);
}
