import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query, queryOne } from "@/lib/db";
import { runStaffAssist } from "@/modules/inbox/staff-assist";
import { type Fixture, makeFixture, uid } from "./helpers";

/** Trợ lý trực nội bộ: chỉ trả lời hội thoại của ĐỘI, Claude được giả lập bằng fetch giả. */

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

function mockClaude(input: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", name: "tra_loi", input }], usage: { input_tokens: 900, output_tokens: 70 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

async function conversation(f: Fixture, kind: "staff" | "group" | "guest", text: string) {
  const conn = await queryOne<{ id: string }>(
    "INSERT INTO connector_accounts (org_id, channel, label, status) VALUES ($1,'whatsapp',$2,'testing') RETURNING id",
    [f.orgId, `WA ${uid()}`],
  );
  const conv = await queryOne<{ id: string }>(
    `INSERT INTO conversations (org_id, channel, connector_id, external_thread_id, kind, handled_by, contact_name, contact_handle, last_message_at)
     VALUES ($1,'whatsapp',$2,$3,$4,'human','Thao','36705930124', now()) RETURNING id`,
    [f.orgId, conn!.id, `thread-${uid()}`, kind],
  );
  await query(
    "INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status) VALUES ($1,$2,'in','staff','Thao',$3,'received')",
    [f.orgId, conv!.id, text],
  );
  return conv!.id;
}

const openSwitches = (f: Fixture) =>
  query(
    `INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'agent','staff_assist',false), ($1,'channel','whatsapp_staff',false)
     ON CONFLICT (org_id, scope, scope_key) DO UPDATE SET paused = false`,
    [f.orgId],
  );

const outbox = (convId: string) =>
  query<{ author_name: string; body: string; status: string }>(
    "SELECT author_name, body, status FROM messages WHERE conversation_id = $1 AND direction = 'out'",
    [convId],
  );

describe("trợ lý trực nội bộ", () => {
  it("công tắc chưa bật ⇒ không gọi Claude, không trả lời", async () => {
    const fetchSpy = mockClaude({ action: "reply", message: "x", note: "" });
    const conv = await conversation(fixture, "staff", "Hệ thống có gì mới không em?");
    const res = await runStaffAssist();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.answered).toBe(0);
    expect(await outbox(conv)).toHaveLength(0);
  });

  it("bật công tắc ⇒ trả lời tin của nhân viên, tin vào hàng đợi gửi, ghi lượt chạy có chi phí", async () => {
    await openSwitches(fixture);
    const conv = await conversation(fixture, "staff", "Hôm nay có xung đột lịch nào không em?");
    mockClaude({ action: "reply", message: "Dạ hôm nay không có xung đột lịch nào ạ.", note: "tra so lieu" });
    const res = await runStaffAssist();
    expect(res.answered).toBe(1);
    const msgs = await outbox(conv);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ author_name: "Dương Quá — trợ lý", status: "queued" });
    const run = await queryOne<{ status: string; output: { costUsd: number; action: string } }>(
      "SELECT status, output FROM agent_runs WHERE org_id = $1 AND agent_role = 'manager'",
      [fixture.orgId],
    );
    expect(run?.status).toBe("succeeded");
    expect(run!.output.action).toBe("reply");
    expect(run!.output.costUsd).toBeGreaterThan(0);
  });

  it("chạy lại lượt sau không trả lời hai lần cho cùng một tin", async () => {
    await openSwitches(fixture);
    const conv = await conversation(fixture, "staff", "Còn thiếu dữ liệu gì em?");
    mockClaude({ action: "reply", message: "Còn link lịch Airbnb và file Excel ạ.", note: "" });
    await runStaffAssist();
    await query("UPDATE messages SET created_at = created_at - interval '5 minutes' WHERE conversation_id = $1", [conv]);
    const second = await runStaffAssist();
    expect(second.answered).toBe(0);
    expect(await outbox(conv)).toHaveLength(1);
  });

  it("trong nhóm chỉ trả lời khi được gọi tên", async () => {
    await openSwitches(fixture);
    const quiet = await conversation(fixture, "group", "Mai mọi người họp lúc 9h nhé");
    mockClaude({ action: "reply", message: "vâng ạ", note: "" });
    await runStaffAssist();
    expect(await outbox(quiet)).toHaveLength(0);

    const called = await conversation(fixture, "group", "Dương Quá ơi, hệ thống còn thiếu gì?");
    await runStaffAssist();
    expect(await outbox(called)).toHaveLength(1);
  });

  it("trong nhóm, bấm @ số tổng đài cũng là gọi trợ lý", async () => {
    await openSwitches(fixture);
    const self = process.env.WHATSAPP_SELF_MENTIONS;
    process.env.WHATSAPP_SELF_MENTIONS = "36704092957,58579830710497";
    try {
      const conv = await conversation(fixture, "group", "@58579830710497 e nhận thông tin c gửi ở trên đây");
      mockClaude({ action: "reply", message: "Dạ em nhận rồi ạ.", note: "duoc goi bang @so" });
      await runStaffAssist();
      expect(await outbox(conv)).toHaveLength(1);
    } finally {
      if (self === undefined) delete process.env.WHATSAPP_SELF_MENTIONS;
      else process.env.WHATSAPP_SELF_MENTIONS = self;
    }
  });

  it("lời gọi trong nhóm bị tin khác đè lên vẫn được trả lời", async () => {
    await openSwitches(fixture);
    const conv = await conversation(fixture, "group", "Dương Quá ơi cho xin số liệu hôm nay");
    // Sau lời gọi, đội còn nhắn tiếp với nhau — trước đây trợ lý chỉ nhìn tin cuối nên im luôn.
    await query(
      "INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status) VALUES ($1,$2,'in','staff','Diu',$3,'received')",
      [fixture.orgId, conv, "ok chị nhé"],
    );
    mockClaude({ action: "reply", message: "Dạ số liệu hôm nay đây ạ.", note: "tra loi loi goi truoc do" });
    const res = await runStaffAssist();
    expect(res.answered).toBe(1);
    expect(await outbox(conv)).toHaveLength(1);
  });

  it("không bao giờ đụng hội thoại của khách", async () => {
    await openSwitches(fixture);
    const guest = await conversation(fixture, "guest", "Hello, what time is check-in?");
    const fetchSpy = mockClaude({ action: "reply", message: "x", note: "" });
    await runStaffAssist();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await outbox(guest)).toHaveLength(0);
  });

  it("Claude lỗi ⇒ không gửi gì, lượt chạy ghi 'failed'", async () => {
    await openSwitches(fixture);
    const conv = await conversation(fixture, "staff", "Báo cáo giúp anh");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }));
    const res = await runStaffAssist();
    expect(res.failed).toBe(1);
    expect(await outbox(conv)).toHaveLength(0);
    const run = await queryOne<{ status: string }>("SELECT status FROM agent_runs WHERE org_id = $1 AND agent_role = 'manager'", [fixture.orgId]);
    expect(run?.status).toBe("failed");
  });
});
