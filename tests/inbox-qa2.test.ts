import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query, queryOne } from "@/lib/db";
import { WEBHOOK_MAX_BYTES, generateWebhookToken, handleEvolutionWebhook, hashWebhookToken } from "@/modules/inbox/evolution";
import { SEND_LIMITS } from "@/modules/inbox/limits";
import { GUEST_PLACEHOLDER, getConversationDetail, listConversations } from "@/modules/inbox/queries";
import { phoneDigits } from "@/modules/inbox/rules";
import { runSendQueue } from "@/modules/inbox/sender";
import { type InboxDeps, ingestInboundMessage, replyToConversation, takeOverConversation } from "@/modules/inbox/service";
import { sendWhatsAppText, toEvolutionNumber } from "@/modules/inbox/transport";
import type { GroundedAnswer } from "@/modules/qa/contract";
import { type Fixture, makeFixture, uid } from "./helpers";

/** Vòng sửa QA2: tiếp quản chặn bot, trần giờ/hội thoại, hạn gửi, @lid, webhook đọc luồng, che tên khách. */

async function whatsappConnector(f: Fixture) {
  const token = generateWebhookToken();
  const row = await queryOne<{ id: string }>(
    "INSERT INTO connector_accounts (org_id, channel, label, status, webhook_secret_hash) VALUES ($1,'whatsapp',$2,'testing',$3) RETURNING id",
    [f.orgId, `WA ${uid()}`, hashWebhookToken(token)],
  );
  return { connectorId: row!.id, token };
}

async function openSwitches(orgId: string) {
  await query(
    "INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'agent','guest',false), ($1,'channel','whatsapp_guest',false) ON CONFLICT (org_id, scope, scope_key) DO UPDATE SET paused = false",
    [orgId],
  );
}

const answer: GroundedAnswer = {
  entryId: "00000000-0000-4000-8000-000000000001",
  entryKey: "00000000-0000-4000-8000-000000000002",
  version: 1,
  scope: "general",
  topic: "check-in",
  answer: "Check-in is from 15:00.",
  language: "en",
  sensitivity: "public",
  score: 0.9,
};

const jid = () => `3670${Math.floor(1_000_000 + Math.random() * 8_999_999)}@s.whatsapp.net`;

function sendStub() {
  return vi.fn<InboxDeps["send"]>(async () => ({ ok: true as const, externalId: `EXT-${uid()}` }));
}

async function guestMessage(f: Fixture, connectorId: string, text: string, thread = jid(), found: GroundedAnswer | null = answer) {
  return ingestInboundMessage(
    { orgId: f.orgId, connectorId, channel: "whatsapp", threadId: thread, externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "Anna Guest", text, occurredAt: null },
    { findAnswer: async () => found },
  );
}

const statusOf = async (id: string) => (await queryOne<{ status: string; error: string | null; locked_at: Date | null; queued_at: Date | null }>("SELECT status, error, locked_at, queued_at FROM messages WHERE id = $1", [id]))!;

let fixture: Fixture;
beforeEach(async () => {
  fixture = await makeFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("C1 — tiếp quản thì bot không gửi", () => {
  it("tiếp quản huỷ tin bot đang xếp hàng; worker không gửi", async () => {
    await openSwitches(fixture.orgId);
    const { connectorId } = await whatsappConnector(fixture);
    const res = await guestMessage(fixture, connectorId, "What time is check-in?");
    expect(res.bot).toMatchObject({ action: "queued" });
    const messageId = (res.bot as { messageId: string }).messageId;
    const r = await takeOverConversation(fixture.actors.vn_staff, res.conversationId);
    expect(r.discardedBotMessages).toBe(1);
    expect(await statusOf(messageId)).toMatchObject({ status: "discarded", error: "taken_over" });
    const send = sendStub();
    await runSendQueue({ send });
    expect(send.mock.calls.filter((c) => c[0] === fixture.orgId)).toHaveLength(0);
  });

  it("worker kiểm lại ngay trước khi gửi: hội thoại đã do người cầm ⇒ discarded, không gọi kênh", async () => {
    await openSwitches(fixture.orgId);
    const { connectorId } = await whatsappConnector(fixture);
    const res = await guestMessage(fixture, connectorId, "What time is check-in?");
    const messageId = (res.bot as { messageId: string }).messageId;
    // Lọt khe: đổi handled_by mà không qua takeOverConversation (tin vẫn 'queued')
    await query("UPDATE conversations SET handled_by = 'human' WHERE id = $1", [res.conversationId]);
    const send = sendStub();
    await runSendQueue({ send });
    expect(await statusOf(messageId)).toMatchObject({ status: "discarded", error: "taken_over" });
    expect(send.mock.calls.filter((c) => c[0] === fixture.orgId)).toHaveLength(0);
  });
});

describe("C2 — trần giờ và trần hội thoại", () => {
  const saved = { url: process.env.EVOLUTION_API_URL, key: process.env.EVOLUTION_API_KEY, inst: process.env.EVOLUTION_INSTANCE };
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = "http://evolution.invalid";
    process.env.EVOLUTION_API_KEY = "test-key";
    process.env.EVOLUTION_INSTANCE = "test";
  });
  afterEach(() => {
    for (const [k, v] of [["EVOLUTION_API_URL", saved.url], ["EVOLUTION_API_KEY", saved.key], ["EVOLUTION_INSTANCE", saved.inst]] as const) {
      if (v) process.env[k] = v;
      else delete process.env[k];
    }
  });

  async function fillSentMessages(f: Fixture, connectorId: string, n: number) {
    const res = await guestMessage(f, connectorId, "hello", jid(), null);
    await query(
      `INSERT INTO messages (org_id, conversation_id, direction, author_type, body, status, connector_id, sent_at)
       SELECT $1, $2, 'out', 'staff', 'x', 'sent', $3, now() - make_interval(mins => g) FROM generate_series(1, $4) g`,
      [f.orgId, res.conversationId, connectorId, n],
    );
    return res.conversationId;
  }

  it("≥30 tin/giờ trên connector ⇒ rate_limited_hour, không gọi Evolution; tin về hàng đợi giữ mốc xếp hàng", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ key: { id: "X" } }), { status: 200 }));
    const { connectorId } = await whatsappConnector(fixture);
    const convId = await fillSentMessages(fixture, connectorId, SEND_LIMITS.connectorPerHour);
    expect(await sendWhatsAppText(fixture.orgId, connectorId, "36701234567", "hi")).toEqual({ ok: false, reason: "rate_limited_hour" });

    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'channel','whatsapp_guest',false)", [fixture.orgId]);
    const r = await replyToConversation(fixture.actors.vn_staff, convId, { body: "Xin chào" });
    const queuedAt = (await statusOf(r.messageId)).queued_at;
    expect(queuedAt).not.toBeNull();
    expect((await statusOf(r.messageId)).locked_at).toBeNull();
    const stats = await runSendQueue();
    expect(stats.deferred).toBeGreaterThanOrEqual(1);
    const after = await statusOf(r.messageId);
    expect(after.status).toBe("queued");
    expect(after.queued_at?.getTime()).toBe(queuedAt?.getTime());
    expect(after.locked_at).toBeNull();
    // Hoãn tới lúc có lượt: tin thứ 30 (mới nhất) cách đây 1 phút… tin cũ nhất trong 30 tin cách 30 phút ⇒ mở lại sau ~30 phút
    const avail = await queryOne<{ minutes: number }>("SELECT extract(epoch FROM available_at - now()) / 60 AS minutes FROM messages WHERE id = $1", [r.messageId]);
    expect(Number(avail!.minutes)).toBeGreaterThan(25);
    expect(Number(avail!.minutes)).toBeLessThan(31);
    // Vòng sau chưa tới available_at ⇒ không giành lại tin
    const again = await runSendQueue();
    expect(again.deferred).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("thông báo đội đã gửi qua CÙNG connector được cộng vào trần của số; connector khác không tính", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ key: { id: "X" } }), { status: 200 }));
    const { connectorId } = await whatsappConnector(fixture);
    const other = await whatsappConnector(fixture);
    await fillSentMessages(fixture, connectorId, SEND_LIMITS.connectorPerHour - 5);
    const notify = (conn: string, sentAgo: string) =>
      query(
        "INSERT INTO staff_notifications (org_id, recipient_user_id, template_key, dedupe_key, status, sent_at, connector_id) VALUES ($1,$2,'t',$3,'sent', now() - $4::interval, $5)",
        [fixture.orgId, fixture.actors.bp_coordinator.userId, `qa2-${uid()}`, sentAgo, conn],
      );
    // 4 thông báo cùng số ⇒ còn 1 chỗ; 10 thông báo qua số khác không tính
    for (let i = 0; i < 4; i++) await notify(connectorId, "5 minutes");
    for (let i = 0; i < 10; i++) await notify(other.connectorId, "5 minutes");
    expect((await sendWhatsAppText(fixture.orgId, connectorId, "36701234567", "hi", { maxWaitMs: 0 })).ok).toBe(true);
    await query("UPDATE connector_accounts SET last_send_at = now() - interval '10 seconds' WHERE id = $1", [connectorId]);
    await notify(connectorId, "0 seconds");
    expect(await sendWhatsAppText(fixture.orgId, connectorId, "36701234567", "hi", { maxWaitMs: 0 })).toEqual({ ok: false, reason: "rate_limited_hour" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bot đã tự gửi 3 tin/giờ trong hội thoại ⇒ câu kế tiếp không xếp hàng, chuyển người 'khách hỏi nhiều'", async () => {
    await openSwitches(fixture.orgId);
    const { connectorId } = await whatsappConnector(fixture);
    const thread = jid();
    const first = await guestMessage(fixture, connectorId, "What time is check-in?", thread);
    await query(
      `INSERT INTO messages (org_id, conversation_id, direction, author_type, body, status, connector_id, sent_at)
       SELECT $1, $2, 'out', 'bot', 'x', 'sent', $3, now() - make_interval(mins => g * 10) FROM generate_series(1, 3) g`,
      [fixture.orgId, first.conversationId, connectorId],
    );
    await query("UPDATE messages SET status = 'discarded' WHERE id = $1", [(first.bot as { messageId: string }).messageId]);
    const next = await guestMessage(fixture, connectorId, "What time is check-in?", thread);
    expect(next.bot).toMatchObject({ action: "handoff", reason: "bot_conversation_limit" });
    const h = await queryOne<{ reason: string }>("SELECT reason FROM handoffs WHERE conversation_id = $1", [first.conversationId]);
    expect(h!.reason).toBe("bot_conversation_limit");
  });

  it("worker: tin bot xếp hàng trong khi bot vừa gửi < 2 phút ⇒ discarded + handoff, không gửi", async () => {
    await openSwitches(fixture.orgId);
    const { connectorId } = await whatsappConnector(fixture);
    const res = await guestMessage(fixture, connectorId, "hello", jid(), null);
    await query(
      "INSERT INTO messages (org_id, conversation_id, direction, author_type, body, status, connector_id, sent_at) VALUES ($1,$2,'out','bot','x','sent',$3, now() - interval '1 minute')",
      [fixture.orgId, res.conversationId, connectorId],
    );
    // Tin bot thứ hai đã lọt vào hàng đợi (ví dụ trước khi có chốt)
    const q = await queryOne<{ id: string }>(
      "INSERT INTO messages (org_id, conversation_id, direction, author_type, body, status, queued_at) VALUES ($1,$2,'out','bot','y','queued', now()) RETURNING id",
      [fixture.orgId, res.conversationId],
    );
    const send = sendStub();
    await runSendQueue({ send });
    expect(await statusOf(q!.id)).toMatchObject({ status: "discarded", error: "bot_conversation_limit" });
    expect(send.mock.calls.filter((c) => c[0] === fixture.orgId)).toHaveLength(0);
    const reasons = await query<{ reason: string }>("SELECT reason FROM handoffs WHERE conversation_id = $1", [res.conversationId]);
    // Hội thoại đã có handoff 'no_grounded_answer' đang mở ⇒ không tạo thêm; nếu chưa có thì tạo 'bot_conversation_limit'
    expect(reasons.length).toBe(1);
  });
});

describe("C3 — tin xếp hàng có hạn", () => {
  it("bot quá 10 phút, nhân viên quá 2 giờ ⇒ failed 'expired', không gửi; tin còn hạn vẫn gửi", async () => {
    await openSwitches(fixture.orgId);
    const { connectorId } = await whatsappConnector(fixture);
    const res = await guestMessage(fixture, connectorId, "hello", jid(), null);
    const ins = async (author: "bot" | "staff", minutesAgo: number) =>
      (await queryOne<{ id: string }>(
        "INSERT INTO messages (org_id, conversation_id, direction, author_type, body, status, queued_at, created_at) VALUES ($1,$2,'out',$3,$4,'queued', now() - make_interval(mins => $5), now() - make_interval(mins => $5)) RETURNING id",
        [fixture.orgId, res.conversationId, author, `${author}-${minutesAgo}`, minutesAgo],
      ))!.id;
    const oldBot = await ins("bot", 11);
    const oldStaff = await ins("staff", 121);
    const freshStaff = await ins("staff", 60);
    const send = sendStub();
    await runSendQueue({ send });
    expect(await statusOf(oldBot)).toMatchObject({ status: "failed", error: "expired" });
    expect(await statusOf(oldStaff)).toMatchObject({ status: "failed", error: "expired" });
    expect((await statusOf(freshStaff)).status).toBe("sent");
    const bodies = send.mock.calls.filter((c) => c[0] === fixture.orgId).map((c) => c[3]);
    expect(bodies).toEqual(["staff-60"]);
  });
});

describe("N — @lid, webhook đọc luồng, che tên khách", () => {
  it("jid @lid không bao giờ thành số điện thoại; trả lời gửi tới jid nguyên văn", async () => {
    const lid = "123456789012345@lid";
    expect(toEvolutionNumber(lid)).toBe(lid);
    expect(phoneDigits(lid)).toBeNull();
    expect(toEvolutionNumber("123@broadcast")).toBeNull();
    expect(toEvolutionNumber("36701234567@s.whatsapp.net")).toBe("36701234567");

    const { connectorId, token } = await whatsappConnector(fixture);
    const body = JSON.stringify({ event: "messages.upsert", data: { key: { remoteJid: lid, fromMe: false, id: `L-${uid()}` }, pushName: "Lid Guest", message: { conversation: "hello" } } });
    const r = await handleEvolutionWebhook(connectorId, token, body, { findAnswer: async () => null });
    expect(r.body.stored).toBe(1);
    const conv = await queryOne<{ id: string; contact_handle: string; external_thread_id: string }>("SELECT id, contact_handle, external_thread_id FROM conversations WHERE org_id = $1", [fixture.orgId]);
    expect(conv).toMatchObject({ contact_handle: lid, external_thread_id: lid });

    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'channel','whatsapp_guest',false)", [fixture.orgId]);
    await replyToConversation(fixture.actors.vn_staff, conv!.id, { body: "Hi" });
    const send = sendStub();
    await runSendQueue({ send });
    const call = send.mock.calls.find((c) => c[0] === fixture.orgId);
    expect(call?.[2]).toBe(lid);
    expect(/^\d+$/.test(String(call?.[2]))).toBe(false);
  });

  function trackedStream(totalBytes: number, chunk = 64 * 1024) {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= totalBytes) return controller.close();
        pulled += chunk;
        controller.enqueue(new Uint8Array(chunk).fill(97));
      },
    });
    return { stream, pulled: () => pulled };
  }

  it("webhook: sai token ⇒ 401 mà không đọc body; đúng token + body chunked quá lớn ⇒ 413 và dừng đọc sớm", async () => {
    const { connectorId, token } = await whatsappConnector(fixture);
    const bad = trackedStream(WEBHOOK_MAX_BYTES * 2);
    expect((await handleEvolutionWebhook(connectorId, "sai", bad.stream)).status).toBe(401);
    expect(bad.pulled()).toBeLessThanOrEqual(64 * 1024); // chỉ phần ReadableStream tự kéo sẵn, không đọc tiếp
    // Bám theo hằng số: trần đã nới lên để ảnh base64 lọt qua, bài kiểm phải nới theo chứ không ghim số cũ.
    const big = trackedStream(WEBHOOK_MAX_BYTES * 2);
    expect((await handleEvolutionWebhook(connectorId, token, big.stream)).status).toBe(413);
    expect(big.pulled()).toBeLessThan(WEBHOOK_MAX_BYTES + 1024 * 1024);
  });

  it("thiếu booking.view_guest_contact (bp_staff, manager_viewer) ⇒ không thấy tên/SĐT khách trong danh sách và chi tiết", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const res = await guestMessage(fixture, connectorId, "hello", jid(), null);
    const filters = { kind: null, unread: false, waiting: false, channel: null };
    for (const actor of [fixture.actors.bp_staff, fixture.actors.manager_viewer]) {
      const list = await listConversations(actor, filters, { page: 1, pageSize: 50, offset: 0 });
      const it = list.items.find((c) => c.id === res.conversationId)!;
      expect(it).toMatchObject({ contact_name: GUEST_PLACEHOLDER, title: GUEST_PLACEHOLDER, contact_handle: null });
      const d = await getConversationDetail(actor, res.conversationId);
      expect(d!.conversation).toMatchObject({ contact_name: GUEST_PLACEHOLDER, title: GUEST_PLACEHOLDER, contact_handle: null });
      expect(d!.messages.filter((m) => m.direction === "in").every((m) => m.author_name === GUEST_PLACEHOLDER)).toBe(true);
      expect(JSON.stringify(d)).not.toContain("Anna Guest");
      expect(JSON.stringify(list)).not.toContain("Anna Guest");
    }
    const d = await getConversationDetail(fixture.actors.vn_staff, res.conversationId);
    expect(d!.conversation.contact_name).toBe("Anna Guest");
  });
});
