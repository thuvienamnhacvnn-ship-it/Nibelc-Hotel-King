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

  it("nhân viên gửi ảnh không kèm chữ vẫn được trả lời (không im lặng)", async () => {
    await openSwitches(fixture);
    const conv = await conversation(fixture, "staff", "");
    await query("UPDATE messages SET body = NULL, attachments = $2 WHERE conversation_id = $1", [
      conv,
      JSON.stringify([{ kind: "image", mimeType: "image/jpeg", bytes: 90244, storageKey: "org/x/inbox/y/z.jpg", sha256: "a".repeat(64) }]),
    ]);
    const fetchSpy = mockClaude({ action: "reply", message: "Dạ em nhận được ảnh rồi, cảm ơn anh ạ.", note: "cam on da gui anh" });
    const res = await runStaffAssist();
    expect(res.answered).toBe(1);
    expect(await outbox(conv)).toHaveLength(1);
    // Trợ lý phải biết là có ảnh và ảnh đã lấy được, nếu không thì nó cảm ơn khơi khơi.
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(String(sent.messages[0].content)).toContain("đã nhận và lưu xong");
  });

  it("ảnh chưa lấy được nội dung thì nói rõ là lỗi bên mình", async () => {
    await openSwitches(fixture);
    const conv = await conversation(fixture, "staff", "");
    await query("UPDATE messages SET body = NULL, attachments = $2 WHERE conversation_id = $1", [
      conv,
      JSON.stringify([{ kind: "image", mimeType: "image/jpeg", bytes: null, error: "khong_lay_duoc: http_404" }]),
    ]);
    const fetchSpy = mockClaude({ action: "reply", message: "Dạ ảnh có tới nhưng bên em chưa lấy được nội dung, em đang sửa ạ.", note: "bao loi" });
    await runStaffAssist();
    expect(await outbox(conv)).toHaveLength(1);
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(String(sent.messages[0].content)).toContain("CHƯA lấy được nội dung");
  });

  it("nhờ báo lên nhóm ⇒ đăng thật lên nhóm, không hứa suông", async () => {
    await openSwitches(fixture);
    const group = await conversation(fixture, "group", "Chào mọi người");
    // Nhóm đã có tin ra nên không còn chờ trả lời, chỉ còn hội thoại riêng là việc cần xử.
    await query("INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status) VALUES ($1,$2,'out','system','Dương Quá — trợ lý','da nhan','sent')", [fixture.orgId, group]);
    const riêng = await conversation(fixture, "staff", "Em báo lên nhóm giục mọi người cập nhật thông tin giúp anh");
    mockClaude({ action: "reply", message: "Dạ em báo lên nhóm ngay ạ.", group_message: "Nhờ mọi người gửi giúp em: sức chứa các phòng, file Excel, danh sách người dọn.", note: "duoc nho bao len nhom" });
    const res = await runStaffAssist();
    expect(res.postedToGroup).toBe(1);
    const inGroup = await outbox(group);
    expect(inGroup).toHaveLength(2);
    expect(inGroup.some((m) => m.body.includes("sức chứa các phòng"))).toBe(true);
    expect((await outbox(riêng))[0].body).toContain("báo lên nhóm");
  });

  it("điền tin nhóm mà bỏ trống câu trả lời: vẫn đăng nhóm và vẫn xác nhận với người nhờ", async () => {
    await openSwitches(fixture);
    const group = await conversation(fixture, "group", "Chào mọi người");
    await query("INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status) VALUES ($1,$2,'out','system','Dương Quá — trợ lý','da nhan','sent')", [fixture.orgId, group]);
    const riêng = await conversation(fixture, "staff", "Em báo lên nhóm giục mọi người giúp anh");
    // Model thật đã làm đúng kiểu này: có group_message, message rỗng.
    mockClaude({ action: "reply", message: "", group_message: "Nhờ mọi người gửi nốt thông tin giúp em ạ.", note: "bao len nhom" });
    const res = await runStaffAssist();
    expect(res.postedToGroup).toBe(1);
    expect((await outbox(group)).some((m) => m.body.includes("gửi nốt thông tin"))).toBe(true);
    expect((await outbox(riêng))[0].body).toBeTruthy();
  });

  it("từ trong nhóm thì không tự đăng thêm tin lên nhóm (tránh tự nói với mình)", async () => {
    await openSwitches(fixture);
    const group = await conversation(fixture, "group", "Dương Quá ơi báo lên nhóm giúp cái");
    mockClaude({ action: "reply", message: "Dạ đây ạ.", group_message: "tin them khong duoc phep", note: "test" });
    const res = await runStaffAssist();
    expect(res.postedToGroup).toBe(0);
    expect(await outbox(group)).toHaveLength(1);
  });

  it("số liệu đặt SAU hội thoại và có cảnh báo số cũ, để trợ lý không nhặt lại số ngày trước", async () => {
    await openSwitches(fixture);
    await conversation(fixture, "staff", "Tình hình hệ thống ổn chưa em?");
    const fetchSpy = mockClaude({ action: "reply", message: "Dạ ổn ạ.", note: "bao cao" });
    await runStaffAssist();
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    const prompt = String(sent.messages[0].content);
    expect(prompt.indexOf("HỘI THOẠI")).toBeLessThan(prompt.indexOf("SỐ LIỆU HỆ THỐNG"));
    expect(prompt).toContain("ĐÃ CŨ, không được dùng lại");
  });

  it("giao việc theo đội hình thật, không đoán theo tên trong chat", async () => {
    await openSwitches(fixture);
    await query("UPDATE users SET full_name = 'Nguyen Thi Ngoc' WHERE org_id = $1 AND role = 'admin'", [fixture.orgId]);
    await conversation(fixture, "staff", "Còn thiếu gì thì ai phải làm em?");
    const fetchSpy = mockClaude({ action: "reply", message: "Dạ đây ạ.", note: "phan viec" });
    await runStaffAssist();
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    const prompt = String(sent.messages[0].content);
    expect(prompt).toContain("ĐỘI HÌNH");
    expect(prompt).toContain("Nguyen Thi Ngoc — Quản trị hệ thống");
    // Luật cấm đoán nằm ở lời dặn hệ thống, không phải trong lời nhắc từng lượt.
    expect(String(sent.system)).toContain("không dồn việc cho người đang nhắn");
  });

  it("hứa 'sẽ báo lên nhóm' mà không soạn tin ⇒ gọi lại một lần và đăng thật", async () => {
    await openSwitches(fixture);
    const group = await conversation(fixture, "group", "Chào mọi người");
    await query("INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status) VALUES ($1,$2,'out','system','Dương Quá — trợ lý','da nhan','sent')", [fixture.orgId, group]);
    await conversation(fixture, "staff", "Em báo lên nhóm giúp anh");
    // Lượt đầu hứa suông, lượt sau mới soạn tin — đúng kiểu model thật đã làm.
    let lan = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      lan += 1;
      const input =
        lan === 1
          ? { action: "reply", message: "Dạ em sẽ báo lên nhóm ngay ạ.", note: "hua" }
          : { action: "reply", message: "Dạ em đã báo lên nhóm ạ.", group_message: "Nhờ mọi người gửi nốt thông tin giúp em.", note: "da lam" };
      return new Response(JSON.stringify({ model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", name: "tra_loi", input }], usage: { input_tokens: 900, output_tokens: 70 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const res = await runStaffAssist();
    expect(lan).toBe(2);
    expect(res.postedToGroup).toBe(1);
    expect((await outbox(group)).some((m) => m.body.includes("gửi nốt thông tin"))).toBe(true);
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
