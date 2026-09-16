import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query, queryOne } from "@/lib/db";
import { addDays, todayOps } from "@/lib/time";
import { createBooking } from "@/modules/booking/service";
import { generateWebhookToken, handleEvolutionWebhook, hashWebhookToken } from "@/modules/inbox/evolution";
import { getConversationDetail, listConversations } from "@/modules/inbox/queries";
import { detectSensitiveIntent, extractBookingClaims } from "@/modules/inbox/rules";
import { type InboxDeps, acceptHandoff, ingestInboundMessage, replyToConversation, takeOverConversation } from "@/modules/inbox/service";
import { runSendQueue } from "@/modules/inbox/sender";
import { sendFailureLabel, sendWhatsAppText } from "@/modules/inbox/transport";
import type { GroundedAnswer } from "@/modules/qa/contract";
import { type Fixture, bookingInput, expectCode, makeFixture, uid } from "./helpers";

async function whatsappConnector(f: Fixture, status = "testing") {
  const token = generateWebhookToken();
  const row = await queryOne<{ id: string }>(
    "INSERT INTO connector_accounts (org_id, channel, label, status, webhook_secret_hash) VALUES ($1,'whatsapp',$2,$3,$4) RETURNING id",
    [f.orgId, `WA ${uid()}`, status, hashWebhookToken(token)],
  );
  return { connectorId: row!.id, token };
}

function upsert(remoteJid: string, id: string, text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: "messages.upsert",
    instance: "test",
    data: { key: { remoteJid, fromMe: false, id }, pushName: "Guest Test", message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), ...extra },
  });
}

const answer = (over: Partial<GroundedAnswer> = {}): GroundedAnswer => ({
  entryId: "00000000-0000-4000-8000-000000000001",
  entryKey: "00000000-0000-4000-8000-000000000002",
  version: 3,
  scope: "general",
  topic: "check-in",
  answer: "Check-in is from 15:00.",
  language: "en",
  sensitivity: "public",
  score: 0.9,
  ...over,
});

function stubDeps(found: GroundedAnswer | null = null) {
  const findAnswer = vi.fn(async () => found);
  const send = vi.fn<InboxDeps["send"]>(async () => ({ ok: true as const, externalId: `EXT-${uid()}` }));
  return { findAnswer, send, deps: { findAnswer, send } satisfies InboxDeps };
}

const jid = () => `3670${Math.floor(1_000_000 + Math.random() * 8_999_999)}@s.whatsapp.net`;

let fixture: Fixture;
beforeEach(async () => {
  fixture = await makeFixture();
});

describe("webhook Evolution", () => {
  it("gửi lặp cùng một tin không tạo bản ghi thứ hai (và không tạo handoff thứ hai)", async () => {
    const { connectorId, token } = await whatsappConnector(fixture);
    const s = stubDeps(null);
    const body = upsert(jid(), `MSG-${uid()}`, "Is there parking nearby?");
    const r1 = await handleEvolutionWebhook(connectorId, token, body, s.deps);
    const r2 = await handleEvolutionWebhook(connectorId, token, body, s.deps);
    expect(r1.status).toBe(200);
    expect(r1.body.stored).toBe(1);
    expect(r2.body.duplicates).toBe(1);
    const msgs = await query("SELECT id FROM messages WHERE org_id = $1 AND direction = 'in'", [fixture.orgId]);
    expect(msgs).toHaveLength(1);
    const handoffs = await query("SELECT id FROM handoffs WHERE org_id = $1", [fixture.orgId]);
    expect(handoffs).toHaveLength(1);
    expect(s.findAnswer).toHaveBeenCalledTimes(1);
  });

  it("token sai hoặc thiếu ⇒ 401, không lưu gì", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const body = upsert(jid(), `MSG-${uid()}`, "hello");
    expect((await handleEvolutionWebhook(connectorId, "sai-token", body, stubDeps().deps)).status).toBe(401);
    expect((await handleEvolutionWebhook(connectorId, null, body, stubDeps().deps)).status).toBe(401);
    expect((await handleEvolutionWebhook("00000000-0000-4000-8000-00000000abcd", "x", body, stubDeps().deps)).status).toBe(401);
    const msgs = await query("SELECT id FROM messages WHERE org_id = $1", [fixture.orgId]);
    expect(msgs).toHaveLength(0);
  });

  it("bỏ tin fromMe và status broadcast; messages.update nâng trạng thái tin đã gửi", async () => {
    const { connectorId, token } = await whatsappConnector(fixture);
    const s = stubDeps(null);
    const fromMe = JSON.stringify({ event: "messages.upsert", data: { key: { remoteJid: jid(), fromMe: true, id: "X1" }, message: { conversation: "out" } } });
    const broadcast = upsert("status@broadcast", "X2", "status");
    expect((await handleEvolutionWebhook(connectorId, token, fromMe, s.deps)).body.stored).toBe(0);
    expect((await handleEvolutionWebhook(connectorId, token, broadcast, s.deps)).body.stored).toBe(0);

    const staffJid = jid();
    await handleEvolutionWebhook(connectorId, token, upsert(staffJid, `MSG-${uid()}`, "hi"), s.deps);
    const conv = await queryOne<{ id: string }>("SELECT id FROM conversations WHERE org_id = $1", [fixture.orgId]);
    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'channel','whatsapp_guest',false)", [fixture.orgId]);
    const sent = await replyToConversation(fixture.actors.vn_staff, conv!.id, { body: "Hello!" });
    expect(sent.status).toBe("queued");
    expect(s.send).not.toHaveBeenCalled();
    await runSendQueue(s.deps);
    expect((await queryOne<{ status: string }>("SELECT status FROM messages WHERE id = $1", [sent.messageId]))!.status).toBe("sent");
    const ext = await queryOne<{ external_message_id: string }>("SELECT external_message_id FROM messages WHERE id = $1", [sent.messageId]);
    const update = JSON.stringify({ event: "MESSAGES_UPDATE", data: { keyId: ext!.external_message_id, remoteJid: staffJid, fromMe: true, status: "DELIVERY_ACK" } });
    expect((await handleEvolutionWebhook(connectorId, token, update, s.deps)).body.statusUpdates).toBe(1);
    const read = JSON.stringify({ event: "messages.update", data: { keyId: ext!.external_message_id, status: "READ" } });
    await handleEvolutionWebhook(connectorId, token, read, s.deps);
    // Gửi lại DELIVERY_ACK sau READ không được hạ trạng thái
    expect((await handleEvolutionWebhook(connectorId, token, update, s.deps)).body.statusUpdates).toBe(0);
    const m = await queryOne<{ status: string }>("SELECT status FROM messages WHERE id = $1", [sent.messageId]);
    expect(m!.status).toBe("read");
  });
});

describe("bot nháp + handoff", () => {
  it("khách hỏi mã cửa ⇒ bot không trả lời, không tra Q&A, tạo handoff + ticket P1 (nhận trong 5 phút) và xếp thông báo", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const s = stubDeps(answer({ answer: "The door code is 1234" }));
    const before = Date.now();
    const res = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "Hi, what is the door code please?", occurredAt: new Date() },
      s.deps,
    );
    expect(res.bot?.action).toBe("handoff");
    expect(s.findAnswer).not.toHaveBeenCalled();
    const outs = await query("SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'out'", [res.conversationId]);
    expect(outs).toHaveLength(0);
    const h = await queryOne<{ status: string; reason: string; ticket_id: string }>("SELECT status, reason, ticket_id FROM handoffs WHERE conversation_id = $1", [res.conversationId]);
    expect(h).toMatchObject({ status: "requested", reason: "access_code" });
    const t = await queryOne<{ priority: string; category: string; accept_due_at: Date }>("SELECT priority, category, accept_due_at FROM tickets WHERE id = $1", [h!.ticket_id]);
    expect(t).toMatchObject({ priority: "P1", category: "access" });
    const dueMin = (t!.accept_due_at.getTime() - before) / 60_000;
    expect(dueMin).toBeGreaterThan(4.9);
    expect(dueMin).toBeLessThan(5.2);
    const notes = await query<{ recipient_user_id: string; template_key: string }>("SELECT recipient_user_id, template_key FROM staff_notifications WHERE org_id = $1", [fixture.orgId]);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.template_key === "inbox.handoff_requested")).toBe(true);
    // Chưa ai bấm nhận ⇒ không có "đã kết nối"
    expect(h!.status).not.toBe("accepted");
  });

  it("không có căn cứ Q&A ⇒ handoff + ticket P2 (15 phút), không nháp", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const s = stubDeps(null);
    const res = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "Can I bring my bicycle inside?", occurredAt: null },
      s.deps,
    );
    expect(res.bot).toMatchObject({ action: "handoff", reason: "no_grounded_answer" });
    const t = await queryOne<{ priority: string; accept_due_at: Date; created_at: Date }>("SELECT priority, accept_due_at, created_at FROM tickets WHERE conversation_id = $1", [res.conversationId]);
    expect(t!.priority).toBe("P2");
    expect(Math.round((t!.accept_due_at.getTime() - t!.created_at.getTime()) / 60_000)).toBe(15);
    expect(await query("SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'out'", [res.conversationId])).toHaveLength(0);
  });

  it("có căn cứ ⇒ nháp kèm grounding; công tắc mặc định dừng nên không gửi", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const s = stubDeps(answer());
    const res = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "What time is check-in?", occurredAt: null },
      s.deps,
    );
    expect(res.bot).toMatchObject({ action: "draft", autoSend: false });
    const m = await queryOne<{ status: string; author_type: string; grounding: { entryId: string; version: number } }>(
      "SELECT status, author_type, grounding FROM messages WHERE conversation_id = $1 AND direction = 'out'",
      [res.conversationId],
    );
    expect(m).toMatchObject({ status: "draft", author_type: "bot" });
    expect(m!.grounding).toMatchObject({ entryId: answer().entryId, version: 3 });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("người tiếp quản ⇒ bot im lặng (không tra Q&A, không nháp); nhận handoff mới ghi accepted", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const thread = jid();
    const s = stubDeps(answer());
    const first = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: thread, externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "I want a refund", occurredAt: null },
      s.deps,
    );
    expect(first.bot).toMatchObject({ action: "handoff", reason: "refund" });
    await takeOverConversation(fixture.actors.bp_coordinator, first.conversationId);
    const second = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: thread, externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "What time is check-in?", occurredAt: null },
      s.deps,
    );
    expect(second.bot).toMatchObject({ action: "skipped", reason: "human_handling" });
    expect(s.findAnswer).not.toHaveBeenCalled();
    expect(await query("SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'out'", [first.conversationId])).toHaveLength(0);

    // Tiếp quản đóng handoff đang mở: accepted bởi người tiếp quản (dừng đẩy cấp)
    const h = await queryOne<{ id: string }>("SELECT id FROM handoffs WHERE conversation_id = $1", [first.conversationId]);
    const after = await queryOne<{ status: string; accepted_by: string }>("SELECT status, accepted_by FROM handoffs WHERE id = $1", [h!.id]);
    expect(after).toMatchObject({ status: "accepted", accepted_by: fixture.actors.bp_coordinator.userId });
    await expectCode(acceptHandoff(fixture.actors.vn_staff, h!.id), "handoff_not_open");
    await expectCode(takeOverConversation(fixture.actors.bp_staff, first.conversationId), "forbidden");
  });

  it("acceptHandoff khi chưa ai tiếp quản ⇒ accepted + hội thoại chuyển người", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const s = stubDeps(null);
    const res = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "Is there a gym?", occurredAt: null },
      s.deps,
    );
    const h = await queryOne<{ id: string }>("SELECT id FROM handoffs WHERE conversation_id = $1", [res.conversationId]);
    await acceptHandoff(fixture.actors.bp_coordinator, h!.id);
    const conv = await queryOne<{ handled_by: string; takeover_by: string }>("SELECT handled_by, takeover_by FROM conversations WHERE id = $1", [res.conversationId]);
    expect(conv).toMatchObject({ handled_by: "human", takeover_by: fixture.actors.bp_coordinator.userId });
  });

  it("số điện thoại trùng nhân viên ⇒ hội thoại staff, nhóm @g.us ⇒ group; bot không chạy", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    await query("UPDATE users SET phone = '+36 70 555 1234' WHERE id = $1", [fixture.actors.cleaner.userId]);
    const s = stubDeps(answer());
    const staff = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: "36705551234@s.whatsapp.net", externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "C", text: "What time is check-in?", occurredAt: null },
      s.deps,
    );
    const group = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: "120363000000000001@g.us", externalMessageId: `M-${uid()}`, senderHandle: "36701112222@s.whatsapp.net", senderName: "X", text: "What time is check-in?", occurredAt: null },
      s.deps,
    );
    const rows = await query<{ id: string; kind: string; staff_user_id: string | null; handled_by: string }>("SELECT id, kind, staff_user_id, handled_by FROM conversations WHERE org_id = $1", [fixture.orgId]);
    expect(rows.find((r) => r.id === staff.conversationId)).toMatchObject({ kind: "staff", staff_user_id: fixture.actors.cleaner.userId, handled_by: "human" });
    expect(rows.find((r) => r.id === group.conversationId)).toMatchObject({ kind: "group", handled_by: "human" });
    expect(staff.bot).toMatchObject({ action: "skipped", reason: "not_guest" });
    expect(s.findAnswer).not.toHaveBeenCalled();
  });
});

describe("nhận diện booking", () => {
  it("sai tên ⇒ không gắn booking; đủ mã + tên + ngày ⇒ matched", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const checkIn = addDays(todayOps(), 10);
    const ref = `HM${uid().toUpperCase()}7`;
    await createBooking(fixture.actors.vn_manager, bookingInput(fixture.units.studio, checkIn, addDays(checkIn, 2), { externalRef: ref, guest: { fullName: "Maria Kovacs" } }));
    const [y, m, d] = checkIn.split("-");
    const s = stubDeps(null);

    const wrong = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: `Booking ${ref}, name John Smith, arriving ${d}/${m}/${y}`, occurredAt: null },
      s.deps,
    );
    const convWrong = await queryOne<{ booking_id: string | null; verification_level: string }>("SELECT booking_id, verification_level FROM conversations WHERE id = $1", [wrong.conversationId]);
    expect(convWrong).toMatchObject({ booking_id: null, verification_level: "none" });

    const right = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: `Booking ${ref.toLowerCase()}, name maria kovacs, arriving ${checkIn}`, occurredAt: null },
      s.deps,
    );
    const convRight = await queryOne<{ booking_id: string | null; unit_id: string | null; verification_level: string }>("SELECT booking_id, unit_id, verification_level FROM conversations WHERE id = $1", [right.conversationId]);
    expect(convRight!.verification_level).toBe("matched");
    expect(convRight!.booking_id).not.toBeNull();
    expect(convRight!.unit_id).toBe(fixture.units.studio);
  });
});

describe("cách ly tổ chức", () => {
  it("người tổ chức khác không xem/không thao tác được hội thoại", async () => {
    const { connectorId } = await whatsappConnector(fixture);
    const res = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "hello there", occurredAt: null },
      stubDeps(null).deps,
    );
    const other = await makeFixture();
    expect(await getConversationDetail(other.actors.admin, res.conversationId)).toBeNull();
    const list = await listConversations(other.actors.admin, { kind: null, unread: false, waiting: false, channel: null }, { page: 1, pageSize: 50, offset: 0 });
    expect(list.items.find((c) => c.id === res.conversationId)).toBeUndefined();
    await expectCode(takeOverConversation(other.actors.admin, res.conversationId), "not_found");
    await expectCode(replyToConversation(other.actors.admin, res.conversationId, { body: "x" }), "not_found");
    // Connector của tổ chức khác không nhận tin cho tổ chức này
    await expectCode(
      ingestInboundMessage({ orgId: other.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "x", occurredAt: null }, stubDeps().deps),
      "not_found",
    );
  });
});

describe("transport WhatsApp", () => {
  const saved = { url: process.env.EVOLUTION_API_URL, key: process.env.EVOLUTION_API_KEY, inst: process.env.EVOLUTION_INSTANCE };
  beforeEach(() => {
    delete process.env.EVOLUTION_API_URL;
    delete process.env.EVOLUTION_API_KEY;
    delete process.env.EVOLUTION_INSTANCE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.url) process.env.EVOLUTION_API_URL = saved.url;
    if (saved.key) process.env.EVOLUTION_API_KEY = saved.key;
    if (saved.inst) process.env.EVOLUTION_INSTANCE = saved.inst;
  });

  it("thiếu cấu hình ⇒ not_configured, không gọi mạng; trả lời thủ công ghi failed kèm lý do", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { connectorId } = await whatsappConnector(fixture);
    expect(await sendWhatsAppText(fixture.orgId, connectorId, "36701234567", "hi")).toEqual({ ok: false, reason: "not_configured" });

    const res = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "hello", occurredAt: null },
      { findAnswer: async () => null },
    );
    // Công tắc kênh còn dừng ⇒ worker ghi failed: switch_paused
    const paused = await replyToConversation(fixture.actors.vn_staff, res.conversationId, { body: "Xin chào" });
    expect(paused.status).toBe("queued");
    await runSendQueue();
    const pm = await queryOne<{ status: string; error: string }>("SELECT status, error FROM messages WHERE id = $1", [paused.messageId]);
    expect(pm!.status).toBe("failed");
    expect(pm!.error).toMatch(/^switch_paused/);
    // Bật kênh ⇒ tới transport thật ⇒ failed: not_configured
    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'channel','whatsapp_guest',false)", [fixture.orgId]);
    const r = await replyToConversation(fixture.actors.vn_staff, res.conversationId, { body: "Xin chào" });
    await runSendQueue();
    const m = await queryOne<{ status: string; error: string }>("SELECT status, error FROM messages WHERE id = $1", [r.messageId]);
    expect(m).toMatchObject({ status: "failed", error: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();

    const demo = await whatsappConnector(fixture, "demo");
    expect(await sendWhatsAppText(fixture.orgId, demo.connectorId, "36701234567", "hi")).toEqual({ ok: false, reason: "connector_demo" });
    await expectCode(replyToConversation(fixture.actors.manager_viewer, res.conversationId, { body: "x" }), "forbidden");
  });

  function configure() {
    process.env.EVOLUTION_API_URL = "http://evolution.invalid";
    process.env.EVOLUTION_API_KEY = "test-key";
    process.env.EVOLUTION_INSTANCE = "test";
  }

  it("hạn mức 1 tin/3 giây tính theo DB: hai lần gửi cùng lúc chỉ một lần gọi Evolution", async () => {
    configure();
    let n = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ key: { id: `EVO-${++n}` } }), { status: 200 }));
    const { connectorId } = await whatsappConnector(fixture);
    const [a, b] = await Promise.all([
      sendWhatsAppText(fixture.orgId, connectorId, "36701234567", "một", { maxWaitMs: 0 }),
      sendWhatsAppText(fixture.orgId, connectorId, "36701234567", "hai", { maxWaitMs: 0 }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok && r.reason === "rate_limited")).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Mốc lần thử nằm trong DB: tiến trình khác (không chung bộ nhớ) cũng thấy chưa tới lượt
    const slot = await queryOne<{ ok: boolean; last_attempt_at: Date | null }>(
      "SELECT last_send_at > now() - interval '3 seconds' AS ok, last_attempt_at FROM connector_accounts WHERE id = $1",
      [connectorId],
    );
    expect(slot!.ok).toBe(true);
    // Cột của bộ nhận sự kiện kênh không bị bộ gửi ghi
    expect(slot!.last_attempt_at).toBeNull();
    // Lùi mốc quá 3 giây ⇒ tới lượt
    await query("UPDATE connector_accounts SET last_send_at = now() - interval '4 seconds' WHERE id = $1", [connectorId]);
    expect((await sendWhatsAppText(fixture.orgId, connectorId, "36701234567", "ba", { maxWaitMs: 0 })).ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("hai lượt worker chạy song song không gửi trùng tin nào", async () => {
    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'channel','whatsapp_guest',false)", [fixture.orgId]);
    const sentBodies: string[] = [];
    const send = vi.fn<InboxDeps["send"]>(async (_o, _c, _to, text) => {
      sentBodies.push(text);
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const, externalId: `EXT-${uid()}` };
    });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { connectorId } = await whatsappConnector(fixture);
      const res = await ingestInboundMessage(
        { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "hello", occurredAt: null },
        { findAnswer: async () => null },
      );
      ids.push((await replyToConversation(fixture.actors.vn_staff, res.conversationId, { body: `tin ${i}` })).messageId);
    }
    await Promise.all([runSendQueue({ send }), runSendQueue({ send }), runSendQueue({ send })]);
    const mine = sentBodies.filter((b) => b.startsWith("tin "));
    expect(mine.sort()).toEqual(["tin 0", "tin 1", "tin 2", "tin 3"]);
    const rows = await query<{ status: string; connector_id: string | null; locked_at: Date | null; sent_at: Date | null }>(
      "SELECT status, connector_id, locked_at, sent_at FROM messages WHERE id = ANY($1::uuid[])",
      [ids],
    );
    expect(rows.every((r) => r.status === "sent" && r.connector_id && r.locked_at && r.sent_at)).toBe(true);
  });

  it("Evolution hết thời gian chờ ⇒ failed 'không rõ đã gửi hay chưa', worker không tự gửi lại", async () => {
    configure();
    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'channel','whatsapp_guest',false)", [fixture.orgId]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const { connectorId } = await whatsappConnector(fixture);
    const res = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "hello", occurredAt: null },
      { findAnswer: async () => null },
    );
    const r = await replyToConversation(fixture.actors.vn_staff, res.conversationId, { body: "Xin chào" });
    await runSendQueue();
    const m = await queryOne<{ status: string; error: string }>("SELECT status, error FROM messages WHERE id = $1", [r.messageId]);
    expect(m!.status).toBe("failed");
    expect(m!.error).toBe("uncertain: timeout");
    expect(sendFailureLabel(m!.error)).toMatch(/Không rõ đã gửi hay chưa — kiểm trên điện thoại trước khi gửi lại/);
    await query("UPDATE connector_accounts SET last_send_at = now() - interval '10 seconds' WHERE id = $1", [connectorId]);
    await runSendQueue();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await queryOne<{ status: string }>("SELECT status FROM messages WHERE id = $1", [r.messageId]))!.status).toBe("failed");
  });

  it("tin kẹt ở trạng thái đang gửi quá lâu ⇒ failed 'không rõ', không gửi lại", async () => {
    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'channel','whatsapp_guest',false)", [fixture.orgId]);
    const { connectorId } = await whatsappConnector(fixture);
    const res = await ingestInboundMessage(
      { orgId: fixture.orgId, connectorId, channel: "whatsapp", threadId: jid(), externalMessageId: `M-${uid()}`, senderHandle: null, senderName: "G", text: "hello", occurredAt: null },
      { findAnswer: async () => null },
    );
    const r = await replyToConversation(fixture.actors.vn_staff, res.conversationId, { body: "Xin chào" });
    // Giả lập tiến trình đã giành quyền gửi rồi chết
    await query("UPDATE messages SET status = 'sending', locked_at = now() - interval '10 minutes', connector_id = $2 WHERE id = $1", [r.messageId, connectorId]);
    const send = vi.fn<InboxDeps["send"]>(async () => ({ ok: true as const, externalId: "X" }));
    await runSendQueue({ send });
    const m = await queryOne<{ status: string; error: string }>("SELECT status, error FROM messages WHERE id = $1", [r.messageId]);
    expect(m!.status).toBe("failed");
    expect(m!.error).toMatch(/^uncertain/);
    expect(send.mock.calls.some((c) => c[3] === "Xin chào" && c[0] === fixture.orgId)).toBe(false);
  });
});

describe("quy tắc thuần", () => {
  it("nhận diện yêu cầu nhạy cảm và bóc mã/ngày", () => {
    expect(detectSensitiveIntent("Mã cửa là gì vậy?")?.reason).toBe("access_code");
    expect(detectSensitiveIntent("I would like a refund")?.reason).toBe("refund");
    expect(detectSensitiveIntent("There is smoke in the kitchen")?.priority).toBe("P0");
    expect(detectSensitiveIntent("What time is check-in?")).toBeNull();
    const c = extractBookingClaims("ref HMABC123, 05/10/2026 and 2026-10-07, 31/02/2026");
    expect(c.refs).toContain("HMABC123");
    expect(c.dates).toHaveLength(2);
    expect(c.dates).toEqual(expect.arrayContaining(["2026-10-05", "2026-10-07"]));
    expect(c.dates).not.toContain("2026-02-31");
  });
});
