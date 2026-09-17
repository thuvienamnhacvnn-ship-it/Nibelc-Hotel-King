import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query, queryOne } from "@/lib/db";
import { redactForAi } from "@/modules/ai/redact";
import { composeGuestReply } from "@/modules/inbox/ai-compose";
import { generateWebhookToken, hashWebhookToken } from "@/modules/inbox/evolution";
import { ingestInboundMessage } from "@/modules/inbox/service";
import { type Fixture, makeFixture, uid } from "./helpers";

/** Trợ lý AI soạn nháp khách: Claude được giả lập bằng fetch giả — không gọi mạng, không tốn tiền. */

let fixture: Fixture;
const realKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  fixture = await makeFixture();
  process.env.ANTHROPIC_API_KEY = "test-key-khong-that";
});
afterEach(() => {
  vi.restoreAllMocks();
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

async function connector(f: Fixture) {
  const row = await queryOne<{ id: string }>(
    "INSERT INTO connector_accounts (org_id, channel, label, status, webhook_secret_hash) VALUES ($1,'whatsapp',$2,'testing',$3) RETURNING id",
    [f.orgId, `WA ${uid()}`, hashWebhookToken(generateWebhookToken())],
  );
  return row!.id;
}

async function approvedEntry(f: Fixture, topic: string, answerEn: string, sensitivity = "public") {
  await query(
    "INSERT INTO qa_entries (org_id, scope, topic, question, answer_en, sensitivity, status, approved_at) VALUES ($1,'general',$2,$3,$4,$5,'approved',now())",
    [f.orgId, topic, `Question about ${topic}`, answerEn, sensitivity],
  );
}

async function enableAi(f: Fixture, extra = "") {
  await query(
    `INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'agent','guest_ai',false)${extra} ON CONFLICT (org_id, scope, scope_key) DO UPDATE SET paused = false`,
    [f.orgId],
  );
}

/** fetch giả: trả đúng một khối tool_use như Claude API. */
function mockClaude(input: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", name: "submit_reply", input }], usage: { input_tokens: 1200, output_tokens: 90 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function guest(f: Fixture, connectorId: string, text: string) {
  return ingestInboundMessage({
    orgId: f.orgId,
    connectorId,
    channel: "whatsapp",
    threadId: `3670${Math.floor(1_000_000 + Math.random() * 8_999_999)}@s.whatsapp.net`,
    externalMessageId: `M-${uid()}`,
    senderHandle: null,
    senderName: "Guest",
    text,
    occurredAt: null,
  });
}

describe("che thông tin cá nhân trước khi gửi AI", () => {
  it("che email, số điện thoại, dãy số dài; giữ mã booking và ngày", () => {
    const out = redactForAi("Hi, booking HM1005, arriving 24.09.2026. Call me +36 70 123 4567 or anna@mail.com, card 4111111111111111");
    expect(out).toContain("HM1005");
    expect(out).toContain("24.09.2026");
    expect(out).not.toContain("123 4567");
    expect(out).not.toContain("anna@mail.com");
    expect(out).not.toContain("4111111111111111");
  });
});

describe("trợ lý AI soạn nháp khách", () => {
  it("công tắc chưa bật ⇒ không gọi Claude, bot quay về tra từ khoá", async () => {
    const fetchSpy = mockClaude({ decision: "answer", reply: "x", entry_ids: ["E1"], language: "en", note: "" });
    await approvedEntry(fixture, "check-in", "Check-in is from 15:00.");
    const res = await guest(fixture, await connector(fixture), "Wann ist der Check-in?");
    expect(fetchSpy).not.toHaveBeenCalled();
    const ai = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND author_name = $2", [res.conversationId, "Trợ lý AI"]);
    expect(ai?.n).toBe(0);
  });

  it("bật công tắc ⇒ nháp 'Trợ lý AI' luôn chờ duyệt, kể cả khi công tắc tự gửi đang mở; ghi lượt chạy + chi phí", async () => {
    await enableAi(fixture, ", ($1,'agent','guest',false), ($1,'channel','whatsapp_guest',false)");
    await approvedEntry(fixture, "check-in", "Check-in is from 15:00.");
    const fetchSpy = mockClaude({ decision: "answer", reply: "Der Check-in ist ab 15:00 Uhr möglich.", entry_ids: ["E1"], language: "de", note: "check-in time" });
    const res = await guest(fixture, await connector(fixture), "Wann ist der Check-in? Tel +36 70 123 4567");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(JSON.stringify(body)).not.toContain("123 4567");
    expect(res.bot).toMatchObject({ action: "draft", autoSend: false });
    const msg = await queryOne<{ status: string; author_name: string; body: string; grounding: { ai: boolean; language: string } }>(
      "SELECT status, author_name, body, grounding FROM messages WHERE id = $1",
      [(res.bot as { messageId: string }).messageId],
    );
    expect(msg).toMatchObject({ status: "draft", author_name: "Trợ lý AI", body: "Der Check-in ist ab 15:00 Uhr möglich." });
    expect(msg!.grounding).toMatchObject({ ai: true, language: "de" });
    const run = await queryOne<{ status: string; cost_minor: number; output: { costUsd: number } }>("SELECT status, cost_minor, output FROM agent_runs WHERE org_id = $1 AND agent_role = 'guest'", [fixture.orgId]);
    expect(run?.status).toBe("succeeded");
    expect(run!.output.costUsd).toBeGreaterThan(0);
  });

  it("AI đưa ra con số không có trong Kho Q&A ⇒ không tạo nháp, chuyển người", async () => {
    await enableAi(fixture);
    await approvedEntry(fixture, "parking", "Street parking is available nearby.");
    mockClaude({ decision: "answer", reply: "Parking costs 4500 HUF per day.", entry_ids: ["E1"], language: "en", note: "" });
    const res = await guest(fixture, await connector(fixture), "How much is parking?");
    expect(res.bot).toMatchObject({ action: "handoff", reason: "no_grounded_answer" });
  });

  it("AI trả lời có dáng mã cửa ⇒ chuyển người mức P1", async () => {
    await enableAi(fixture);
    await approvedEntry(fixture, "arrival", "Our team will send arrival details before check-in.");
    mockClaude({ decision: "answer", reply: "The code is 4821.", entry_ids: ["E1"], language: "en", note: "" });
    const res = await guest(fixture, await connector(fixture), "Where do I find the arrival details?");
    expect(res.bot).toMatchObject({ action: "handoff", reason: "access_like_answer" });
  });

  it("hỏi mã cửa ⇒ chặn trước, không gửi tin khách cho AI", async () => {
    await enableAi(fixture);
    await approvedEntry(fixture, "check-in", "Check-in is from 15:00.");
    const fetchSpy = mockClaude({ decision: "answer", reply: "x", entry_ids: ["E1"], language: "en", note: "" });
    const res = await guest(fixture, await connector(fixture), "What is the door code?");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.bot).toMatchObject({ action: "handoff", reason: "access_code" });
  });

  it("Claude lỗi ⇒ bot quay về tra từ khoá, lượt chạy ghi 'failed'", async () => {
    await enableAi(fixture);
    await approvedEntry(fixture, "check-in", "Check-in is from 15:00.");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }));
    const res = await guest(fixture, await connector(fixture), "What time is check-in?");
    expect(res.bot?.action).not.toBe("handoff");
    const run = await queryOne<{ status: string; error: string }>("SELECT status, error FROM agent_runs WHERE org_id = $1 AND agent_role = 'guest'", [fixture.orgId]);
    expect(run).toMatchObject({ status: "failed" });
    expect(run!.error).toContain("529");
  });

  it("vượt trần chi phí tháng ⇒ không gọi Claude", async () => {
    await enableAi(fixture);
    await approvedEntry(fixture, "check-in", "Check-in is from 15:00.");
    await query(
      "INSERT INTO agent_runs (org_id, agent_role, task_key, status, output) VALUES ($1,'guest',$2,'succeeded',$3)",
      [fixture.orgId, `ai_reply:old-${uid()}`, JSON.stringify({ costUsd: 999 })],
    );
    const fetchSpy = mockClaude({ decision: "answer", reply: "x", entry_ids: ["E1"], language: "en", note: "" });
    const r = await composeGuestReply({
      orgId: fixture.orgId,
      conversationId: "00000000-0000-4000-8000-000000000001",
      inboundMessageId: "00000000-0000-4000-8000-000000000002",
      text: "check-in?",
      grounding: { orgId: fixture.orgId, text: "check-in?", verification: "none", opsDate: "2026-09-17" },
    });
    expect(r).toEqual({ status: "unavailable", reason: "budget_exceeded" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
