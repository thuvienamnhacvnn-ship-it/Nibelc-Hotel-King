import { describe, expect, it } from "vitest";
import { query, queryOne, withTx } from "@/lib/db";
import { addDays } from "@/lib/time";
import { userActor } from "@/modules/auth/actor";
import { createBooking, requestChange } from "@/modules/booking/service";
import { escalateOverdueHandoffs, escalateOverdueTickets } from "@/modules/manager/escalation";
import { runScheduledReportsJob } from "@/modules/manager/jobs";
import { listStaffNotifications } from "@/modules/manager/queries";
import { buildDailyReport, computeDailyReport } from "@/modules/manager/report";
import { approveTemplate, saveTemplateDraft, setAutomationSwitch } from "@/modules/manager/service";
import { enqueueStaffNotification } from "@/modules/notifications/enqueue";
import { type WhatsAppTransport, sendQueuedNotifications } from "@/modules/notifications/sender";
import { type Fixture, bookingInput, expectCode, makeFixture, runWorker, uid } from "./helpers";

const D = "2026-11-10";

async function enqueue(f: Fixture, userId: string, key = `t:${uid()}`, channel: "whatsapp" | "inapp" = "whatsapp", payload: Record<string, unknown> = { summary: "Khách không vào được phòng" }) {
  return withTx((tx) => enqueueStaffNotification(tx, { orgId: f.orgId, recipientUserId: userId, templateKey: "ticket_escalation", payload, dedupeKey: key, channel }));
}

/** Mở đủ điều kiện gửi cho một người: công tắc bật, mẫu duyệt, số điện thoại, connector WhatsApp, số đã từng nhắn vào. */
async function allowSending(f: Fixture, userId: string, opts: { switches?: boolean; template?: "approved" | "draft" | null; inbound?: boolean } = {}) {
  if (opts.switches ?? true) {
    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused, reason) VALUES ($1,'channel','whatsapp_staff',false,'thử'), ($1,'agent','manager',false,'thử')", [f.orgId]);
  }
  const tpl = opts.template === undefined ? "approved" : opts.template;
  if (tpl) await query("INSERT INTO message_templates (org_id, key, language, body, status) VALUES ($1,'ticket_escalation','vi','Cảnh báo: {{summary}}',$2)", [f.orgId, tpl]);
  const phone = `3670${Math.floor(Math.random() * 1e7)}`;
  await query("UPDATE users SET phone = $2 WHERE id = $1", [userId, `+${phone}`]);
  const conn = await queryOne<{ id: string }>("INSERT INTO connector_accounts (org_id, channel, label, status) VALUES ($1,'whatsapp',$2,'testing') RETURNING id", [f.orgId, `WA ${uid()}`]);
  if (opts.inbound ?? true) {
    await query("INSERT INTO conversations (org_id, channel, connector_id, external_thread_id, kind, last_inbound_at) VALUES ($1,'whatsapp',$2,$3,'staff',now())", [
      f.orgId,
      conn!.id,
      `${phone}@s.whatsapp.net`,
    ]);
  }
  return { phone, connectorId: conn!.id };
}

function fakeTransport(result: Awaited<ReturnType<WhatsAppTransport>> = { ok: true, externalId: `wamid-${uid()}` }) {
  const calls: { to: string; text: string }[] = [];
  const fn: WhatsAppTransport = async (_org, _conn, to, text) => {
    calls.push({ to, text });
    return result;
  };
  return { fn, calls };
}

async function notif(id: string) {
  return (await queryOne<{ status: string; suppressed_reason: string | null; error: string | null; rendered_body: string | null; external_message_id: string | null }>(
    "SELECT status, suppressed_reason, error, rendered_body, external_message_id FROM staff_notifications WHERE id = $1",
    [id],
  ))!;
}

describe("Agent Manager — báo cáo ngày", () => {
  it("tách số booking và số phòng; hủy/mới 24h; yêu cầu chờ; tổ chức khác không thấy", async () => {
    const f = await makeFixture();
    const staff = f.actors.vn_manager;
    // Nhận hôm D: 1 booking 2 phòng
    await createBooking(staff, bookingInput([f.units.r2, f.units.r3], D, addDays(D, 2)));
    // Trả hôm D: 1 booking 1 phòng
    await createBooking(staff, bookingInput(f.units.studio, addDays(D, -2), D));
    // Ở tiếp: 1 booking 1 phòng, có yêu cầu gia hạn đang chờ
    const stay = await createBooking(staff, bookingInput(f.units.r1, addDays(D, -1), addDays(D, 1)));
    await requestChange(f.actors.vn_staff, stay.id, { kind: "dates", checkInDate: addDays(D, -1), checkOutDate: addDays(D, 3) });
    // Booking khác ngày rồi hủy
    const cancelled = await createBooking(staff, bookingInput(f.units.whole, addDays(D, 10), addDays(D, 12)));
    await requestChange(staff, cancelled.id, { kind: "cancel", reason: "Khách hủy" }, { applyNow: true });
    await runWorker();

    const d = await computeDailyReport(f.orgId, "morning", D);
    expect(d.movement.arrivals).toEqual({ bookings: 1, units: 2 });
    expect(d.movement.departures).toEqual({ bookings: 1, units: 1 });
    expect(d.movement.stayovers).toEqual({ bookings: 1, units: 1 });
    expect(d.last24h.newBookings.bookings).toBe(4);
    expect(d.last24h.newBookings.units).toBe(4);
    expect(d.last24h.cancelledBookings).toEqual({ bookings: 1, units: 1 });
    expect(d.pendingChangeRequests.total).toBe(1);
    expect(d.arrivalsNotReady.units).toBe(2);
    expect(d.sourcesFailed).toEqual([]);

    const saved = await buildDailyReport(f.orgId, "morning", D);
    expect(saved.narrative).toContain("không chứng minh khách đã đến");
    expect(saved.narrative).toContain("1 booking / 2 phòng");
    const again = await buildDailyReport(f.orgId, "morning", D);
    const rows = await query<{ id: string; status: string }>("SELECT id, status FROM manager_reports WHERE org_id = $1 ORDER BY created_at", [f.orgId]);
    expect(rows.map((r) => r.status)).toEqual(["superseded", "draft"]);
    expect(rows[1].id).toBe(again.id);

    const other = await makeFixture();
    const o = await computeDailyReport(other.orgId, "morning", D);
    expect(o.movement.arrivals).toEqual({ bookings: 0, units: 0 });
    expect(o.last24h.newBookings.bookings).toBe(0);
  });
});

describe("Bộ gửi thông báo cho đội", () => {
  it("công tắc chưa bật ⇒ suppressed 'paused', không gọi transport", async () => {
    const f = await makeFixture();
    await allowSending(f, f.actors.bp_coordinator.userId!, { switches: false });
    const q = await enqueue(f, f.actors.bp_coordinator.userId!);
    const t = fakeTransport();
    await sendQueuedNotifications({ transport: t.fn, orgId: f.orgId });
    expect((await notif(q.id!)).status).toBe("suppressed");
    expect((await notif(q.id!)).suppressed_reason).toBe("paused");
    expect(t.calls).toHaveLength(0);
  });

  it("mẫu chưa duyệt ⇒ suppressed", async () => {
    const f = await makeFixture();
    await allowSending(f, f.actors.bp_coordinator.userId!, { template: "draft" });
    const q = await enqueue(f, f.actors.bp_coordinator.userId!);
    const t = fakeTransport();
    await sendQueuedNotifications({ transport: t.fn, orgId: f.orgId });
    expect(await notif(q.id!)).toMatchObject({ status: "suppressed", suppressed_reason: "template_not_approved" });
    expect(t.calls).toHaveLength(0);
  });

  it("số chưa từng nhắn vào tổng đài ⇒ suppressed 'recipient_never_messaged'", async () => {
    const f = await makeFixture();
    await allowSending(f, f.actors.bp_coordinator.userId!, { inbound: false });
    const q = await enqueue(f, f.actors.bp_coordinator.userId!);
    const t = fakeTransport();
    await sendQueuedNotifications({ transport: t.fn, orgId: f.orgId });
    expect(await notif(q.id!)).toMatchObject({ status: "suppressed", suppressed_reason: "recipient_never_messaged" });
    expect(t.calls).toHaveLength(0);
  });

  it("đủ điều kiện ⇒ gửi đúng nội dung đã điền mẫu; transport lỗi ⇒ failed, không bao giờ 'sent'", async () => {
    const f = await makeFixture();
    const user = f.actors.bp_coordinator.userId!;
    const { phone } = await allowSending(f, user);
    const ok = await enqueue(f, user);
    const t = fakeTransport({ ok: true, externalId: "wamid-1" });
    await sendQueuedNotifications({ transport: t.fn, orgId: f.orgId });
    expect(await notif(ok.id!)).toMatchObject({ status: "sent", external_message_id: "wamid-1", rendered_body: "Cảnh báo: Khách không vào được phòng" });
    expect(t.calls).toEqual([{ to: phone, text: "Cảnh báo: Khách không vào được phòng" }]);

    const f2 = await makeFixture();
    const u2 = f2.actors.bp_coordinator.userId!;
    await allowSending(f2, u2);
    const bad = await enqueue(f2, u2);
    await sendQueuedNotifications({ transport: fakeTransport({ ok: false, reason: "evolution_not_configured" }).fn, orgId: f2.orgId });
    expect(await notif(bad.id!)).toMatchObject({ status: "failed", error: "evolution_not_configured", external_message_id: null });

    const f3 = await makeFixture();
    const u3 = f3.actors.bp_coordinator.userId!;
    await allowSending(f3, u3);
    const thrown = await enqueue(f3, u3);
    await sendQueuedNotifications({
      transport: async () => {
        throw new Error("mạng lỗi");
      },
      orgId: f3.orgId,
    });
    expect((await notif(thrown.id!)).status).toBe("failed");
  });

  it("chưa tới lượt gửi của số tổng đài ⇒ trả về hàng đợi; tin kẹt 'sending' quá 2 phút ⇒ failed, không gửi lại", async () => {
    const f = await makeFixture();
    const user = f.actors.bp_coordinator.userId!;
    await allowSending(f, user);
    const q = await enqueue(f, user);
    const t = fakeTransport({ ok: false, reason: "rate_limited" });
    const stats = await sendQueuedNotifications({ transport: t.fn, orgId: f.orgId });
    expect(stats.deferred).toBe(1);
    const row = await queryOne<{ status: string; locked_at: Date | null }>("SELECT status, locked_at FROM staff_notifications WHERE id = $1", [q.id]);
    expect(row).toMatchObject({ status: "queued", locked_at: null });

    const stuck = await enqueue(f, f.actors.admin.userId!);
    await query("UPDATE staff_notifications SET status = 'sending', locked_at = now() - interval '3 minutes' WHERE id = $1", [stuck.id]);
    const ok = fakeTransport();
    await sendQueuedNotifications({ transport: ok.fn, orgId: f.orgId });
    expect((await notif(stuck.id!)).status).toBe("failed");
    expect(ok.calls.every((c) => c.text.length > 0)).toBe(true);
    expect((await query("SELECT id FROM staff_notifications WHERE id = $1 AND status = 'sent'", [stuck.id])).length).toBe(0);
  });

  it("kênh trong app ⇒ chỉ đánh dấu sent, không gọi transport", async () => {
    const f = await makeFixture();
    const q = await enqueue(f, f.actors.admin.userId!, `a:${uid()}`, "inapp");
    const t = fakeTransport();
    await sendQueuedNotifications({ transport: t.fn, orgId: f.orgId });
    expect((await notif(q.id!)).status).toBe("sent");
    expect(t.calls).toHaveLength(0);
  });

  it("hạn mức: 1 tin/phút/người và 20 tin/giờ/tổ chức", async () => {
    const f = await makeFixture();
    const user = f.actors.bp_coordinator.userId!;
    await allowSending(f, user);
    const a = await enqueue(f, user);
    const b = await enqueue(f, user);
    const t = fakeTransport();
    await sendQueuedNotifications({ transport: t.fn, orgId: f.orgId });
    const statuses = [await notif(a.id!), await notif(b.id!)];
    expect(statuses.filter((s) => s.status === "sent")).toHaveLength(1);
    expect(statuses.find((s) => s.status === "suppressed")?.suppressed_reason).toBe("rate_limit_recipient");

    const g = await makeFixture();
    const u = g.actors.bp_coordinator.userId!;
    await allowSending(g, u);
    for (let i = 0; i < 20; i++) {
      await query(
        "INSERT INTO staff_notifications (org_id, recipient_user_id, template_key, dedupe_key, status, sent_at) VALUES ($1,$2,'ticket_escalation',$3,'sent', now() - interval '10 minutes')",
        [g.orgId, g.actors.admin.userId, `old:${i}`],
      );
    }
    const c = await enqueue(g, u);
    await sendQueuedNotifications({ transport: fakeTransport().fn, orgId: g.orgId });
    expect(await notif(c.id!)).toMatchObject({ status: "suppressed", suppressed_reason: "rate_limit_org" });
  });
});

describe("Đẩy lên cấp trên", () => {
  async function leaderOf(f: Fixture) {
    const u = await queryOne<{ id: string }>("INSERT INTO users (org_id, email, full_name, role, password_hash, is_demo) VALUES ($1,$2,'Leader thử','leader','x',true) RETURNING id", [
      f.orgId,
      `leader-${uid()}@test.local`,
    ]);
    return u!.id;
  }

  it("ticket P1 quá hạn: lên từng cấp, chạy lại không thêm thông báo, hết cấp ⇒ Leader rồi dừng", async () => {
    const f = await makeFixture();
    const leader = await leaderOf(f);
    await query("INSERT INTO escalation_contacts (org_id, purpose, level, user_id) VALUES ($1,'maintenance',0,$2), ($1,'maintenance',1,$3)", [
      f.orgId,
      f.actors.bp_coordinator.userId,
      f.actors.bp_staff.userId,
    ]);
    const t0 = new Date("2026-11-10T10:00:00Z");
    const ticket = await queryOne<{ id: string }>(
      "INSERT INTO tickets (org_id, category, priority, summary, accept_due_at) VALUES ($1,'maintenance','P1','Mất nước nóng',$2) RETURNING id",
      [f.orgId, new Date(t0.getTime() - 60_000)],
    );
    const count = async () => (await query("SELECT id FROM staff_notifications WHERE org_id = $1", [f.orgId])).length;

    const first = await escalateOverdueTickets(f.orgId, t0);
    expect(first.notifications).toBe(1);
    await escalateOverdueTickets(f.orgId, t0);
    expect(await count()).toBe(1);
    const lvl1 = await query<{ recipient_user_id: string; dedupe_key: string }>("SELECT recipient_user_id, dedupe_key FROM staff_notifications WHERE org_id = $1", [f.orgId]);
    expect(lvl1[0].recipient_user_id).toBe(f.actors.bp_staff.userId);
    expect(lvl1[0].dedupe_key).toBe(`ticket:${ticket!.id}:esc:1:${f.actors.bp_staff.userId}`);

    const t1 = new Date(t0.getTime() + 6 * 60_000);
    await escalateOverdueTickets(f.orgId, t1);
    const lvl2 = await query<{ recipient_user_id: string }>("SELECT recipient_user_id FROM staff_notifications WHERE org_id = $1 AND dedupe_key LIKE '%:esc:2:%'", [f.orgId]);
    expect(lvl2.map((r) => r.recipient_user_id)).toEqual([leader]);

    const t2 = new Date(t1.getTime() + 6 * 60_000);
    const after = await escalateOverdueTickets(f.orgId, t2);
    expect(after.notifications).toBe(0);
    expect(await count()).toBe(2);
    const row = await queryOne<{ escalation_level: number }>("SELECT escalation_level FROM tickets WHERE id = $1", [ticket!.id]);
    expect(row!.escalation_level).toBe(2);

    // Ticket đã nhận thì không đẩy
    const accepted = await queryOne<{ id: string }>(
      "INSERT INTO tickets (org_id, category, priority, summary, status, accept_due_at) VALUES ($1,'maintenance','P1','Đã nhận','accepted',$2) RETURNING id",
      [f.orgId, new Date(t0.getTime() - 60_000)],
    );
    await escalateOverdueTickets(f.orgId, t2);
    expect((await queryOne<{ escalation_level: number }>("SELECT escalation_level FROM tickets WHERE id = $1", [accepted!.id]))!.escalation_level).toBe(0);
  });

  it("handoff hết cấp ⇒ callback, không bao giờ ghi đã kết nối; tổ chức khác không bị đụng", async () => {
    const f = await makeFixture();
    await leaderOf(f);
    await query("INSERT INTO escalation_contacts (org_id, purpose, level, user_id) VALUES ($1,'guest_support',0,$2), ($1,'guest_support',1,$3)", [
      f.orgId,
      f.actors.bp_coordinator.userId,
      f.actors.bp_staff.userId,
    ]);
    const conv = await queryOne<{ id: string }>("INSERT INTO conversations (org_id, channel, external_thread_id) VALUES ($1,'webapp',$2) RETURNING id", [f.orgId, `th-${uid()}`]);
    const t0 = new Date("2026-11-10T10:00:00Z");
    const h = await queryOne<{ id: string }>(
      "INSERT INTO handoffs (org_id, conversation_id, reason, target_user_id, accept_due_at) VALUES ($1,$2,'Khách cần người thật',$3,$4) RETURNING id",
      [f.orgId, conv!.id, f.actors.bp_coordinator.userId, new Date(t0.getTime() - 60_000)],
    );
    const other = await makeFixture();
    const otherConv = await queryOne<{ id: string }>("INSERT INTO conversations (org_id, channel, external_thread_id) VALUES ($1,'webapp',$2) RETURNING id", [other.orgId, `th-${uid()}`]);
    const otherH = await queryOne<{ id: string }>("INSERT INTO handoffs (org_id, conversation_id, reason, accept_due_at) VALUES ($1,$2,'x',$3) RETURNING id", [
      other.orgId,
      otherConv!.id,
      new Date(t0.getTime() - 60_000),
    ]);

    const status = async () => (await queryOne<{ status: string; accepted_at: Date | null }>("SELECT status, accepted_at FROM handoffs WHERE id = $1", [h!.id]))!;
    await escalateOverdueHandoffs(f.orgId, t0);
    expect((await status()).status).toBe("escalated");
    expect((await queryOne<{ escalation_level: number }>("SELECT escalation_level FROM handoffs WHERE id = $1", [h!.id]))!.escalation_level).toBe(1);
    await escalateOverdueHandoffs(f.orgId, t0);
    expect((await query("SELECT id FROM staff_notifications WHERE org_id = $1", [f.orgId])).length).toBe(1);

    await escalateOverdueHandoffs(f.orgId, new Date(t0.getTime() + 6 * 60_000));
    const final = await status();
    expect(final.status).toBe("callback");
    expect(final.accepted_at).toBeNull();
    expect((await queryOne<{ escalation_level: number }>("SELECT escalation_level FROM handoffs WHERE id = $1", [h!.id]))!.escalation_level).toBe(2);
    await escalateOverdueHandoffs(f.orgId, new Date(t0.getTime() + 20 * 60_000));
    const keys = (await query<{ dedupe_key: string }>("SELECT dedupe_key FROM staff_notifications WHERE org_id = $1 ORDER BY created_at", [f.orgId])).map((r) => r.dedupe_key.split(":")[2]);
    expect(keys).toEqual(["esc", "callback"]);

    expect((await queryOne<{ status: string }>("SELECT status FROM handoffs WHERE id = $1", [otherH!.id]))!.status).toBe("requested");
    const otherList = await listStaffNotifications(other.actors.admin, null, { page: 1, pageSize: 50, offset: 0 });
    expect(otherList.total).toBe(0);
  });
});

describe("Agent Center — công tắc và mẫu tin", () => {
  it("bật công tắc cần quyền + lý do; người soạn mẫu không tự duyệt", async () => {
    const f = await makeFixture();
    await expectCode(setAutomationSwitch(f.actors.vn_staff, { scope: "channel", key: "whatsapp_staff", paused: false, reason: "thử bật" }), "forbidden");
    await expect(setAutomationSwitch(f.actors.vn_manager, { scope: "channel", key: "whatsapp_staff", paused: false, reason: "" })).rejects.toThrow("Cần lý do");
    await setAutomationSwitch(f.actors.vn_manager, { scope: "channel", key: "whatsapp_staff", paused: false, reason: "Ngọc đồng ý thử" });
    const sw = await queryOne<{ paused: boolean; updated_by: string }>("SELECT paused, updated_by FROM automation_switches WHERE org_id = $1 AND scope = 'channel'", [f.orgId]);
    expect(sw).toMatchObject({ paused: false, updated_by: f.actors.vn_manager.userId });

    const tpl = await saveTemplateDraft(f.actors.vn_manager, { key: "ticket_escalation", language: "vi", body: "Cảnh báo {{summary}}" });
    await expectCode(approveTemplate(f.actors.vn_manager, tpl.id), "forbidden");
    await expectCode(approveTemplate(f.actors.vn_staff, tpl.id), "forbidden");
    const leaderId = (await queryOne<{ id: string }>("INSERT INTO users (org_id, email, full_name, role, password_hash) VALUES ($1,$2,'L','leader','x') RETURNING id", [f.orgId, `l-${uid()}@t.local`]))!.id;
    const leader = userActor({ userId: leaderId, orgId: f.orgId, role: "leader", fullName: "L", timezone: "Europe/Budapest" });
    expect((await queryOne<{ created_by: string }>("SELECT created_by FROM message_templates WHERE id = $1", [tpl.id]))!.created_by).toBe(f.actors.vn_manager.userId);
    await approveTemplate(leader, tpl.id);
    expect((await queryOne<{ status: string }>("SELECT status FROM message_templates WHERE id = $1", [tpl.id]))!.status).toBe("approved");

    // Tổ chức khác không duyệt được mẫu của tổ chức này
    const other = await makeFixture();
    await saveTemplateDraft(f.actors.admin, { key: "daily_report", language: "vi", body: "Báo cáo {{summary}}" });
    const t2 = await queryOne<{ id: string }>("SELECT id FROM message_templates WHERE org_id = $1 AND key = 'daily_report'", [f.orgId]);
    await expectCode(approveTemplate(other.actors.vn_manager, t2!.id), "not_found");
  });
});

describe("Báo cáo theo lịch", () => {
  it("đăng ký tắt hoặc công tắc dừng ⇒ không lập/không xếp tin; bật ⇒ một tin mỗi ngày", async () => {
    const f = await makeFixture();
    const user = f.actors.vn_manager.userId!;
    const sub = await queryOne<{ id: string }>(
      "INSERT INTO report_subscriptions (org_id, user_id, kind, channel, send_time, enabled) VALUES ($1,$2,'morning','inapp','08:00',false) RETURNING id",
      [f.orgId, user],
    );
    // 08:10 giờ Budapest ngày 10/11/2026 (CET, UTC+1)
    const at = new Date("2026-11-10T07:10:00Z");
    const count = async (sql: string) => (await query(sql, [f.orgId])).length;
    await runScheduledReportsJob(at);
    expect(await count("SELECT id FROM staff_notifications WHERE org_id = $1")).toBe(0);

    await query("UPDATE report_subscriptions SET enabled = true WHERE id = $1", [sub!.id]);
    await runScheduledReportsJob(at);
    expect(await count("SELECT id FROM manager_reports WHERE org_id = $1")).toBe(0);

    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused, reason) VALUES ($1,'channel','report_delivery',false,'thử'), ($1,'agent','manager',false,'thử')", [f.orgId]);
    await runScheduledReportsJob(at);
    await runScheduledReportsJob(new Date(at.getTime() + 5 * 60_000));
    expect(await count("SELECT id FROM manager_reports WHERE org_id = $1")).toBe(1);
    const n = await query<{ dedupe_key: string; template_key: string }>("SELECT dedupe_key, template_key FROM staff_notifications WHERE org_id = $1", [f.orgId]);
    expect(n).toHaveLength(1);
    expect(n[0].dedupe_key).toBe(`report:2026-11-10:morning:inapp:${user}`);

    // Ngoài cửa sổ giờ gửi: không làm gì
    await runScheduledReportsJob(new Date("2026-11-11T12:00:00Z"));
    expect(await count("SELECT id FROM staff_notifications WHERE org_id = $1")).toBe(1);
  });
});
