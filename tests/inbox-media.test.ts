import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryOne } from "@/lib/db";
import { generateWebhookToken, handleEvolutionWebhook, hashWebhookToken, parseEvolutionPayload } from "@/modules/inbox/evolution";
import { MAX_MEDIA_BYTES } from "@/modules/inbox/media";
import { ingestInboundMessage } from "@/modules/inbox/service";
import { readObject } from "@/modules/photos/storage";
import { type Fixture, makeFixture, uid } from "./helpers";

/**
 * Ảnh / clip đội gửi vào tổng đài WhatsApp: webhook kèm nội dung base64 thì phải ghi ra đĩa NGAY,
 * vì Evolution không giữ lịch sử để tải lại sau.
 */

let uploadDir = "";
let fixture: Fixture;

beforeAll(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-inbox-media-"));
  process.env.UPLOAD_DIR = uploadDir;
});
afterAll(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
});
beforeEach(async () => {
  fixture = await makeFixture();
});

const jpeg = (salt: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(salt)]);

async function connector(f: Fixture) {
  const row = await queryOne<{ id: string }>(
    "INSERT INTO connector_accounts (org_id, channel, label, status) VALUES ($1,'whatsapp',$2,'testing') RETURNING id",
    [f.orgId, `WA ${uid()}`],
  );
  return row!.id;
}

function upsertPayload(body: Record<string, unknown>) {
  return { event: "messages.upsert", data: { key: { remoteJid: "36301234567@s.whatsapp.net", id: uid(), fromMe: false }, pushName: "Nguoi don", messageTimestamp: 1758700000, ...body } };
}

/** Payload ảnh THẬT của Evolution 2.3.7: chỉ mô tả tệp, không hề có base64 (đo 25/09/2026). */
function imageUpsert(id: string) {
  return JSON.stringify({
    event: "messages.upsert",
    instance: "test",
    data: {
      key: { remoteJid: "36301234567@s.whatsapp.net", fromMe: false, id },
      pushName: "Nguoi don",
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7118-24/xxx.enc",
          mimetype: "image/jpeg",
          directPath: "/v/t62.7118-24/xxx.enc",
          mediaKey: { 0: 1, 1: 2 },
          height: 1600,
          width: 1200,
        },
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  });
}

async function webhookConnector(f: Fixture) {
  const token = generateWebhookToken();
  const row = await queryOne<{ id: string }>(
    "INSERT INTO connector_accounts (org_id, channel, label, status, webhook_secret_hash) VALUES ($1,'whatsapp',$2,'testing',$3) RETURNING id",
    [f.orgId, `WA ${uid()}`, hashWebhookToken(token)],
  );
  return { connectorId: row!.id, token };
}

const stub = () => ({ findAnswer: vi.fn(async () => null), send: vi.fn(async () => ({ ok: true as const, externalId: uid() })) });

describe("tệp gửi vào tổng đài WhatsApp", () => {
  it("webhook không kèm nội dung ⇒ hỏi kênh giải mã, gửi kèm CẢ object tin", async () => {
    const { connectorId, token } = await webhookConnector(fixture);
    const data = jpeg(uid());
    const fetchMedia = vi.fn(async () => ({ ok: true as const, base64: data.toString("base64") }));
    const res = await handleEvolutionWebhook(connectorId, token, imageUpsert(uid()), { ...stub(), fetchMedia });
    expect(res.status).toBe(200);
    expect(fetchMedia).toHaveBeenCalledTimes(1);
    // Gửi mỗi mã tin thì Evolution trả "Message not found" — phải có phần message.
    const sent = fetchMedia.mock.calls[0][2] as { key?: unknown; message?: unknown };
    expect(sent.key).toBeTruthy();
    expect(sent.message).toBeTruthy();
    const row = await queryOne<{ attachments: { storageKey?: string; sha256?: string }[] }>(
      "SELECT attachments FROM messages WHERE org_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1",
      [fixture.orgId],
    );
    expect(row!.attachments[0].storageKey).toBeTruthy();
    expect(await readObject(row!.attachments[0].storageKey!)).toEqual(data);
  });

  it("kênh trả lỗi ⇒ tin nhắn vẫn vào, ghi rõ vì sao thiếu ảnh", async () => {
    const { connectorId, token } = await webhookConnector(fixture);
    const fetchMedia = vi.fn(async () => ({ ok: false as const, reason: "http_404" }));
    await handleEvolutionWebhook(connectorId, token, imageUpsert(uid()), { ...stub(), fetchMedia });
    const row = await queryOne<{ attachments: { error?: string }[] }>(
      "SELECT attachments FROM messages WHERE org_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1",
      [fixture.orgId],
    );
    expect(row!.attachments[0].error).toBe("khong_lay_duoc: http_404");
  });

  it("bóc được kiểu tệp, tên tệp và nội dung base64 từ webhook", () => {
    const { upserts } = parseEvolutionPayload(
      upsertPayload({ message: { imageMessage: { mimetype: "image/jpeg", caption: "phong 5001 xong roi" }, base64: jpeg("a").toString("base64") } }),
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0].text).toBe("phong 5001 xong roi");
    expect(upserts[0].attachments[0]).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
    expect(upserts[0].attachments[0].base64).toBeTruthy();
  });

  it("tệp kèm lời nhắn (documentWithCaptionMessage) vẫn lấy được tên và kiểu", () => {
    const { upserts } = parseEvolutionPayload(
      upsertPayload({
        message: {
          documentWithCaptionMessage: {
            message: { documentMessage: { mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "lich-dat-phong.xlsx", caption: "file thang 9" } },
          },
          base64: Buffer.from("PKfake").toString("base64"),
        },
      }),
    );
    expect(upserts[0].attachments[0]).toMatchObject({ kind: "document", fileName: "lich-dat-phong.xlsx" });
    expect(upserts[0].text).toBe("file thang 9");
  });

  it("ghi tệp ra đĩa và lưu khoá + mã băm vào tin nhắn, không lưu nội dung vào DB", async () => {
    const connectorId = await connector(fixture);
    const data = jpeg(uid());
    const res = await ingestInboundMessage({
      orgId: fixture.orgId, connectorId, channel: "whatsapp",
      threadId: "36301234567@s.whatsapp.net", externalMessageId: uid(),
      senderHandle: "36301234567@s.whatsapp.net", senderName: "Nguoi don",
      text: "phong xong roi", occurredAt: null,
      attachments: [{ kind: "image", mimeType: "image/jpeg", fileName: "IMG_1.jpg", base64: data.toString("base64") }],
    });
    expect(res.status).toBe("stored");
    const row = await queryOne<{ attachments: { storageKey?: string; sha256?: string; bytes?: number; base64?: string }[] }>(
      "SELECT attachments FROM messages WHERE id = $1",
      [res.messageId],
    );
    const att = row!.attachments[0];
    expect(att.storageKey).toMatch(/^org\//);
    expect(att.sha256).toHaveLength(64);
    expect(att.bytes).toBe(data.length);
    expect(att.base64).toBeUndefined();
    expect(await readObject(att.storageKey!)).toEqual(data);
  });

  it("gửi lại y hệt tệp cũ thì bị đánh dấu trùng", async () => {
    const connectorId = await connector(fixture);
    const data = jpeg(uid());
    const att = { kind: "image", mimeType: "image/jpeg", fileName: null, base64: data.toString("base64") };
    const first = await ingestInboundMessage({
      orgId: fixture.orgId, connectorId, channel: "whatsapp",
      threadId: "36301234567@s.whatsapp.net", externalMessageId: uid(),
      senderHandle: "36301234567@s.whatsapp.net", senderName: "Nguoi don", text: null, occurredAt: null,
      attachments: [att],
    });
    const second = await ingestInboundMessage({
      orgId: fixture.orgId, connectorId, channel: "whatsapp",
      threadId: "36301234567@s.whatsapp.net", externalMessageId: uid(),
      senderHandle: "36301234567@s.whatsapp.net", senderName: "Nguoi don", text: null, occurredAt: null,
      attachments: [att],
    });
    const one = await queryOne<{ attachments: { duplicateOf?: { messageId: string } }[] }>("SELECT attachments FROM messages WHERE id = $1", [first.messageId]);
    const two = await queryOne<{ attachments: { duplicateOf?: { messageId: string } }[] }>("SELECT attachments FROM messages WHERE id = $1", [second.messageId]);
    expect(one!.attachments[0].duplicateOf).toBeUndefined();
    expect(two!.attachments[0].duplicateOf?.messageId).toBe(first.messageId);
  });

  it("kiểu tệp lạ hoặc tệp quá lớn: ghi lý do, tin nhắn vẫn vào", async () => {
    const connectorId = await connector(fixture);
    const res = await ingestInboundMessage({
      orgId: fixture.orgId, connectorId, channel: "whatsapp",
      threadId: "36301234567@s.whatsapp.net", externalMessageId: uid(),
      senderHandle: "36301234567@s.whatsapp.net", senderName: "Nguoi don", text: "day nhe", occurredAt: null,
      attachments: [
        { kind: "document", mimeType: "application/x-msdownload", fileName: "setup.exe", base64: Buffer.from("MZ").toString("base64") },
        { kind: "video", mimeType: "video/mp4", fileName: null, base64: Buffer.alloc(MAX_MEDIA_BYTES + 1).toString("base64") },
      ],
    });
    const row = await queryOne<{ body: string; attachments: { error?: string; storageKey?: string }[] }>("SELECT body, attachments FROM messages WHERE id = $1", [res.messageId]);
    expect(row!.body).toBe("day nhe");
    expect(row!.attachments[0].error).toBe("kieu_tep_khong_nhan");
    expect(row!.attachments[1].error).toBe("tep_qua_lon");
    expect(row!.attachments.every((a) => !a.storageKey)).toBe(true);
  });

  it("webhook chưa bật base64: vẫn ghi nhận có tệp kèm lý do thiếu nội dung", async () => {
    const connectorId = await connector(fixture);
    const res = await ingestInboundMessage({
      orgId: fixture.orgId, connectorId, channel: "whatsapp",
      threadId: "36301234567@s.whatsapp.net", externalMessageId: uid(),
      senderHandle: "36301234567@s.whatsapp.net", senderName: "Nguoi don", text: null, occurredAt: null,
      attachments: [{ kind: "image", mimeType: "image/jpeg", fileName: null, base64: null }],
    });
    const row = await queryOne<{ attachments: { error?: string }[] }>("SELECT attachments FROM messages WHERE id = $1", [res.messageId]);
    expect(row!.attachments[0].error).toBe("khong_co_noi_dung");
  });
});
