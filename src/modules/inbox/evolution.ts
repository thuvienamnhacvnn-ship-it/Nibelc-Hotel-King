import crypto from "node:crypto";
import { query, queryOne } from "@/lib/db";
import { type InboundMessage, type InboxDeps, ingestInboundMessage } from "./service";

/**
 * Webhook Evolution API v2. Payload là dữ liệu KHÔNG tin cậy: giới hạn kích thước, chỉ bóc trường cần,
 * không log nội dung tin. Xác thực bằng header `x-webhook-token` so với băm sha256 lưu ở connector.
 */

export const WEBHOOK_MAX_BYTES = 256 * 1024;

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

/** Bóc chữ từ các dạng tin phổ biến; ảnh/tệp chỉ ghi loại, không lưu nội dung nhị phân. */
function extractContent(message: Json | null): { text: string | null; attachments: { kind: string }[] } {
  if (!message) return { text: null, attachments: [] };
  const ext = obj(message.extendedTextMessage);
  const text = str(message.conversation) ?? str(ext?.text) ?? null;
  const attachments: { kind: string }[] = [];
  for (const [key, kind] of [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
    ["locationMessage", "location"],
  ] as const) {
    const m = obj(message[key]);
    if (m) {
      attachments.push({ kind });
      const caption = str(m.caption);
      if (caption && !text) return { text: caption, attachments };
    }
  }
  return { text, attachments };
}

export interface ParsedUpsert {
  threadId: string;
  externalMessageId: string;
  senderHandle: string | null;
  senderName: string | null;
  text: string | null;
  attachments: { kind: string }[];
  occurredAt: Date | null;
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
      const content = extractContent(obj(d.message));
      const ts = Number(d.messageTimestamp);
      upserts.push({
        threadId: remoteJid,
        externalMessageId: id,
        senderHandle: remoteJid.endsWith("@g.us") ? str(key?.participant) ?? str(d.participant) : remoteJid,
        senderName: str(d.pushName)?.slice(0, 200) ?? null,
        text: content.text,
        attachments: content.attachments,
        occurredAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null,
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

export async function handleEvolutionWebhook(connectorId: string, token: string | null, rawBody: string, deps?: Partial<InboxDeps>): Promise<WebhookResult> {
  const unauthorized: WebhookResult = { status: 401, body: { error: { code: "unauthorized", message: "Token webhook không hợp lệ." } } };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectorId)) return unauthorized;
  const connector = await queryOne<{ id: string; org_id: string; channel: string; webhook_secret_hash: string | null; is_demo: boolean }>(
    `SELECT ca.id, ca.org_id, ca.channel, ca.webhook_secret_hash, o.is_demo
       FROM connector_accounts ca JOIN organizations o ON o.id = ca.org_id WHERE ca.id = $1`,
    [connectorId],
  );
  // Không phân biệt "không có connector" với "sai token" — tránh dò mã connector.
  if (!connector || connector.channel !== "whatsapp" || !tokenMatches(token, connector.webhook_secret_hash)) return unauthorized;
  if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_MAX_BYTES) return { status: 413, body: { error: { code: "payload_too_large", message: "Payload quá lớn." } } };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: { code: "invalid_json", message: "Body không phải JSON hợp lệ." } } };
  }
  const parsed = parseEvolutionPayload(payload);
  let stored = 0;
  let duplicates = 0;
  let statusUpdates = 0;
  for (const u of parsed.upserts) {
    const input: InboundMessage = { orgId: connector.org_id, connectorId: connector.id, channel: "whatsapp", ...u, isDemo: connector.is_demo };
    const res = await ingestInboundMessage(input, deps);
    if (res.status === "duplicate") duplicates++;
    else stored++;
  }
  for (const s of parsed.statuses) statusUpdates += await applyDeliveryStatus(connector.org_id, connector.id, s);
  return { status: 200, body: { ok: true, event: parsed.event || null, stored, duplicates, statusUpdates, ignored: parsed.ignored } };
}
