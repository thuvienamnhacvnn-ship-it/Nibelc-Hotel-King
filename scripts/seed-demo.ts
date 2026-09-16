/**
 * Dữ liệu DEMO ẩn danh cho Đợt 1. Mọi bản ghi mang is_demo = true và tên có chữ "Demo".
 * KHÔNG chứa danh mục phòng thật, tên/số điện thoại khách thật, mật khẩu OTA hay mã cửa.
 *
 * Kịch bản có sẵn (ngày tính tương đối theo hôm nay giờ Budapest):
 *   - Nguyên căn A000 (3 phòng) + phòng lẻ A001–A003: phòng lẻ trả hôm nay, nguyên căn nhận hôm nay (quay vòng)
 *   - Booking nhiều phòng (A002 + A003) trả hôm nay, khách đã trả phòng → cleaner bắt đầu được
 *   - Booking đổi phòng giữa kỳ (B002 → C001)
 *   - Booking đã hủy, booking gia hạn chờ duyệt, xung đột từ kênh demo, chặn tồn bảo trì
 *   - Việc dọn ở nhiều trạng thái, cleaner có ca làm
 *
 * Chạy: npm run db:seed   (database đã migrate; KHÔNG chạy khi đang có tiến trình khác mở cùng thư mục PGlite)
 */
import { loadLocalEnv } from "../src/lib/env";

loadLocalEnv();

const { closePool, query, queryOne } = await import("../src/lib/db");
const { hashPassword } = await import("../src/modules/auth/password");
const { userActor } = await import("../src/modules/auth/actor");
const { createBooking, createInventoryBlock, requestChange, setStayStatus } = await import("../src/modules/booking/service");
const { ingestBookingEvent } = await import("../src/modules/connectors/ingest");
const { acceptTask, assignTask, startTask } = await import("../src/modules/cleaning/service");
const { drainOutbox } = await import("../src/modules/outbox/outbox");
const { handlers } = await import("../src/worker/handlers");
const { addDays, todayOps } = await import("../src/lib/time");
type Role = import("../src/modules/auth/permissions").Role;

// Máy dev dùng mật khẩu chung ghi trong README. Server mở ra Internet PHẢI đặt DEMO_PASSWORD riêng.
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "Demo-Nibelc-2026";
if (process.env.NODE_ENV === "production" && !process.env.DEMO_PASSWORD) {
  console.error("Đang ở production: đặt DEMO_PASSWORD riêng trước khi seed (không dùng mật khẩu DEMO công khai).");
  process.exit(1);
}

/** Service tạo booking/khách/việc không biết là DEMO — gắn cờ cho mọi bản ghi của tổ chức DEMO. */
async function markDemo(orgId: string) {
  for (const table of ["bookings", "guests", "cleaning_tasks"]) {
    await query(`UPDATE ${table} SET is_demo = true WHERE org_id = $1 AND NOT is_demo`, [orgId]);
  }
}

async function main() {
  const exists = await queryOne("SELECT id FROM organizations WHERE slug = 'nibelc-demo'");
  if (exists) {
    console.log("Đã có dữ liệu DEMO (tổ chức nibelc-demo). Muốn làm lại: dừng db:dev, xoá thư mục .pgdata, migrate rồi seed.");
    return;
  }
  const today = todayOps();
  const d = (n: number) => addDays(today, n);
  const hash = await hashPassword(DEMO_PASSWORD);

  const org = (await queryOne<{ id: string }>("INSERT INTO organizations (slug, name, is_demo) VALUES ('nibelc-demo', 'Vietduc Hotel (DEMO)', true) RETURNING id"))!;
  const other = (await queryOne<{ id: string }>("INSERT INTO organizations (slug, name, is_demo) VALUES ('don-vi-thu-cach-ly', 'Đơn vị thử cách ly (DEMO)', true) RETURNING id"))!;

  const users: [string, string, Role][] = [
    ["admin@demo.nibelc.local", "Quản trị (DEMO)", "admin"],
    ["diu@demo.nibelc.local", "Dịu — Vietnam Team (DEMO)", "vn_manager"],
    ["hoa@demo.nibelc.local", "Hoà — Vietnam Team (DEMO)", "vn_staff"],
    ["thao@demo.nibelc.local", "Thảo — điều phối Budapest (DEMO)", "bp_coordinator"],
    ["budapest@demo.nibelc.local", "Budapest Team (DEMO)", "bp_staff"],
    ["ngoc@demo.nibelc.local", "Ngọc — quản lý (DEMO)", "manager_viewer"],
    ["cleaner.a@demo.nibelc.local", "Cleaner A (DEMO)", "cleaner"],
    ["cleaner.b@demo.nibelc.local", "Cleaner B (DEMO)", "cleaner"],
    ["cleaner.c@demo.nibelc.local", "Cleaner C (DEMO)", "cleaner"],
  ];
  const actors = {} as Record<string, ReturnType<typeof userActor>>;
  for (const [email, name, role] of users) {
    const u = (await queryOne<{ id: string }>(
      "INSERT INTO users (org_id, email, full_name, role, password_hash, is_demo) VALUES ($1,$2,$3,$4,$5,true) RETURNING id",
      [org.id, email, name, role, hash],
    ))!;
    actors[email.split("@")[0]] = userActor({ userId: u.id, orgId: org.id, role, fullName: name, timezone: "Europe/Budapest" });
  }
  await query("INSERT INTO users (org_id, email, full_name, role, password_hash, is_demo) VALUES ($1,'admin@cach-ly.demo.local','Quản trị đơn vị khác (DEMO)','admin',$2,true)", [other.id, hash]);

  // ── Danh mục mẫu ──
  async function property(code: string, name: string, address: string) {
    return (await queryOne<{ id: string }>(
      "INSERT INTO properties (org_id, code, name, address, data_status, data_note, is_demo) VALUES ($1,$2,$3,$4,'confirmed','Nhà mẫu DEMO',true) RETURNING id",
      [org.id, code, name, address],
    ))!.id;
  }
  async function resource(propertyId: string, code: string, name: string, kind = "room") {
    return (await queryOne<{ id: string }>("INSERT INTO resources (org_id, property_id, code, name, kind, is_demo) VALUES ($1,$2,$3,$4,$5,true) RETURNING id", [org.id, propertyId, code, name, kind]))!.id;
  }
  async function unit(propertyId: string, code: string, name: string, kind: string, capacity: number, beds: string, resIds: string[], order: number, note?: string) {
    const id = (await queryOne<{ id: string }>(
      `INSERT INTO units (org_id, property_id, code, name, kind, capacity, bed_config, data_status, data_note, sort_order, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
      [org.id, propertyId, code, name, kind, capacity, beds, note ? "needs_confirmation" : "confirmed", note ?? null, order],
    ))!.id;
    for (const r of resIds) await query("INSERT INTO unit_resources (unit_id, resource_id, org_id) VALUES ($1,$2,$3)", [id, r, org.id]);
    await query("INSERT INTO channel_listings (org_id, unit_id, channel, account_label, listing_name, external_listing_id, status, data_status, is_demo) VALUES ($1,$2,'airbnb','Tài khoản Airbnb DEMO',$3,$4,'active','confirmed',true)", [
      org.id,
      id,
      `${name} (DEMO listing)`,
      `DEMO-AB-${code}`,
    ]);
    if (kind !== "whole") {
      await query("INSERT INTO channel_listings (org_id, unit_id, channel, account_label, listing_name, external_listing_id, status, data_status, is_demo) VALUES ($1,$2,'booking_com','Tài khoản Booking DEMO',$3,$4,'active','needs_confirmation',true)", [
        org.id,
        id,
        `Double Room (${name} DEMO)`,
        null,
      ]);
    }
    return id;
  }

  const pA = await property("DEMO-A", "Nhà Demo A — 3 phòng", "Demo utca 1, 1000 Budapest (địa chỉ mẫu)");
  const [ra1, ra2, ra3] = [await resource(pA, "DEMO-A-R1", "Phòng 1"), await resource(pA, "DEMO-A-R2", "Phòng 2"), await resource(pA, "DEMO-A-R3", "Phòng 3")];
  const A000 = await unit(pA, "A000", "Demo A nguyên căn", "whole", 8, "3 phòng", [ra1, ra2, ra3], 0);
  const A001 = await unit(pA, "A001", "Demo A — Phòng 1", "room", 2, "1 giường đôi", [ra1], 1);
  const A002 = await unit(pA, "A002", "Demo A — Phòng 2", "room", 3, "1 giường đôi, 1 giường đơn", [ra2], 2);
  const A003 = await unit(pA, "A003", "Demo A — Phòng 3", "room", 4, "2 giường đôi", [ra3], 3, "Sức chứa trên listing và mô tả giường chưa khớp — cần xác nhận (mô phỏng ca 6501)");

  const pB = await property("DEMO-B", "Nhà Demo B — 2 phòng + studio", "Minta körút 2, 1000 Budapest (địa chỉ mẫu)");
  const [rb1, rb2, rbs] = [await resource(pB, "DEMO-B-R1", "Phòng 1"), await resource(pB, "DEMO-B-R2", "Phòng 2"), await resource(pB, "DEMO-B-S", "Studio", "studio")];
  const B000 = await unit(pB, "B000", "Demo B nguyên căn", "whole", 6, "2 phòng", [rb1, rb2], 0);
  const B001 = await unit(pB, "B001", "Demo B — Phòng 1", "room", 3, "1 giường đôi, 1 sofa", [rb1], 1);
  const B002 = await unit(pB, "B002", "Demo B — Phòng 2", "room", 3, "1 giường đôi, 1 sofa", [rb2], 2);
  const B010 = await unit(pB, "B010", "Demo B — Studio", "studio", 4, "2 giường đôi", [rbs], 3, "Quan hệ studio với nguyên căn chưa được khai báo — đang tách riêng (mô phỏng ca 6503/6500)");

  const pC = await property("DEMO-C", "Studio Demo C", "Példa utca 3, 1000 Budapest (địa chỉ mẫu)");
  const rc = await resource(pC, "DEMO-C-S", "Studio", "studio");
  const C001 = await unit(pC, "C001", "Studio Demo C", "studio", 2, "1 giường đôi", [rc], 0);
  void B000;

  await query(
    `INSERT INTO checklist_templates (org_id, property_id, name, items, is_demo) VALUES ($1, NULL, 'Checklist mẫu (DEMO — chờ Budapest Team cung cấp bản thật)', $2, true)`,
    [
      org.id,
      JSON.stringify([
        { key: "bed_linen", label: "Giường và đồ vải đã thay", category: "Phòng ngủ", requiresPhoto: true },
        { key: "floor", label: "Sàn sạch", category: "Chung", requiresPhoto: true },
        { key: "bathroom", label: "Nhà tắm / WC sạch", category: "Nhà tắm", requiresPhoto: true },
        { key: "kitchen", label: "Bếp (nếu có) sạch", category: "Bếp", requiresPhoto: true },
        { key: "trash", label: "Đã đổ thùng rác", category: "Chung", requiresPhoto: false },
        { key: "towels", label: "Khăn đủ theo số khách", category: "Nhà tắm", requiresPhoto: true },
        { key: "supplies", label: "Vật tư (giấy, xà phòng) đủ", category: "Vật tư", requiresPhoto: false },
      ]),
    ],
  );

  // ── Cleaner và ca làm ──
  for (const [key, preferred] of [["cleaner.a", [pA]], ["cleaner.b", [pB, pC]], ["cleaner.c", []]] as const) {
    const a = actors[key];
    await query("INSERT INTO cleaner_profiles (user_id, org_id, max_tasks_per_day, preferred_property_ids, is_demo) VALUES ($1,$2,4,$3,true)", [a.userId, org.id, preferred]);
    for (let i = -1; i <= 7; i++) {
      if (key === "cleaner.c" && i % 2 === 0) continue;
      await query("INSERT INTO cleaner_shifts (org_id, user_id, work_date, start_time, end_time, is_demo) VALUES ($1,$2,$3,'09:00','17:00',true)", [org.id, a.userId, d(i)]);
    }
  }

  // ── Kết nối: chỉ nguồn demo là "demo"; kênh thật để "chưa cấu hình" ──
  const caps = (x: Record<string, boolean>) => JSON.stringify(x);
  await query("INSERT INTO connector_accounts (org_id, channel, label, status, capabilities) VALUES ($1,'airbnb','Airbnb',$2,$3)", [
    org.id,
    "not_configured",
    caps({ bookings: false, messages: false, calendar_ical: false }),
  ]);
  await query("INSERT INTO connector_accounts (org_id, channel, label, status, capabilities) VALUES ($1,'booking_com','Booking.com',$2,$3)", [
    org.id,
    "not_configured",
    caps({ bookings: false, messages: false, calendar_ical: false }),
  ]);
  await query("INSERT INTO connector_accounts (org_id, channel, label, status, capabilities) VALUES ($1,'whatsapp','WhatsApp',$2,$3)", [org.id, "not_configured", caps({ messages: false, calling: false })]);
  await query("INSERT INTO connector_accounts (org_id, channel, label, status, capabilities) VALUES ($1,'viber','Viber',$2,$3)", [org.id, "not_configured", caps({ messages: false, calling: false })]);
  const demoConn = (await queryOne<{ id: string }>(
    "INSERT INTO connector_accounts (org_id, channel, label, status, capabilities, config) VALUES ($1,'airbnb','Nguồn sự kiện DEMO (giả lập Airbnb)','demo',$2,$3) RETURNING id",
    [org.id, caps({ bookings: true }), JSON.stringify({ note: "Adapter giả lập — không kết nối Airbnb thật" })],
  ))!.id;

  // ── Booking ──
  const vn = actors.diu;
  const guest = (n: string) => ({ fullName: `Khách Demo ${n}` });
  const mk = (units: string[], ci: string, co: string, extra: Record<string, unknown> = {}) =>
    createBooking(vn, { sourceChannel: "manual", guest: guest(String(Math.floor(Math.random() * 900 + 100))), checkInDate: ci, checkOutDate: co, allocations: units.map((unitId) => ({ unitId })), ...extra });

  const b1 = await mk([A001], d(-2), d(0), { sourceChannel: "airbnb", externalRef: "DEMO-HM1001", adults: 2, totalAmount: "180.00", etaLocal: "16:00" });
  const b2 = await mk([A000], d(0), d(3), { sourceChannel: "booking_com", externalRef: "DEMO-BK2002", adults: 6, children: 1, totalAmount: "690.00", etaLocal: "18:30" });
  const b3 = await mk([A002, A003], d(-4), d(0), { sourceChannel: "booking_com", externalRef: "DEMO-BK2003", adults: 5, totalAmount: "520.00" });
  const b4 = await mk([B001], d(0), d(2), { sourceChannel: "airbnb", externalRef: "DEMO-HM1004", adults: 2, totalAmount: "150.00" });
  const b5 = await mk([B002], d(-2), d(2), { sourceChannel: "airbnb", externalRef: "DEMO-HM1005", adults: 2, totalAmount: "260.00" });
  const b6 = await mk([B010], d(-1), d(1), { sourceChannel: "booking_com", externalRef: "DEMO-BK2006", adults: 3, totalAmount: "210.00" });
  const b7 = await mk([B010], d(1), d(4), { sourceChannel: "airbnb", externalRef: "DEMO-HM1007", adults: 4, totalAmount: "330.00" });
  const b8 = await mk([C001], d(5), d(7), { sourceChannel: "direct", externalRef: "DEMO-DR3008", adults: 2, totalAmount: "140.00" });
  await mk([A001], d(4), d(8), { sourceChannel: "airbnb", externalRef: "DEMO-HM1009", adults: 1, totalAmount: "300.00" });
  await mk([B000], d(3), d(6), { sourceChannel: "booking_com", externalRef: "DEMO-BK2010", adults: 5, totalAmount: "450.00" });
  await mk([C001], d(-3), d(0), { sourceChannel: "manual", adults: 2, opsNote: "Khách quen, đặt qua điện thoại (DEMO)" });

  const v = async (id: string) => (await queryOne<{ version: number }>("SELECT version FROM bookings WHERE id = $1", [id]))!.version;
  const bp = actors.budapest;
  await setStayStatus(bp, b1.id, { status: "checked_in", expectedVersion: await v(b1.id) });
  await setStayStatus(bp, b3.id, { status: "checked_in", expectedVersion: await v(b3.id) });
  await setStayStatus(bp, b3.id, { status: "checked_out", expectedVersion: await v(b3.id) });
  await setStayStatus(bp, b5.id, { status: "checked_in", expectedVersion: await v(b5.id) });
  await setStayStatus(bp, b6.id, { status: "checked_in", expectedVersion: await v(b6.id) });

  // Đổi phòng giữa kỳ: khách B002 chuyển sang C001 từ ngày mai — C001 phải trống d(1)..d(2)
  const allocB5 = (await queryOne<{ id: string }>("SELECT id FROM booking_allocations WHERE booking_id = $1 AND status = 'active'", [b5.id]))!.id;
  await requestChange(vn, b5.id, { kind: "move_unit", allocationId: allocB5, toUnitId: C001, effectiveDate: d(1) }, { note: "Máy lạnh phòng 2 hỏng (DEMO)", applyNow: true });

  // Hủy đã xác nhận
  await requestChange(vn, b8.id, { kind: "cancel", reason: "Khách hủy qua email (DEMO)" }, { applyNow: true });
  // Yêu cầu gia hạn đang chờ duyệt (xung đột với khách B010 kế tiếp → kiểm tra báo không đủ chỗ)
  await requestChange(actors.hoa, b6.id, { kind: "dates", checkInDate: d(-1), checkOutDate: d(2) }, { source: "guest_message", note: "Khách nhắn xin ở thêm 1 đêm (DEMO)" });
  // Yêu cầu hợp lệ đang chờ
  await requestChange(actors.thao, b4.id, { kind: "late_checkout", time: "12:00" }, { source: "guest_message", note: "Khách hỏi trả phòng 12h (DEMO)" });

  // Chặn tồn bảo trì
  await createInventoryBlock(actors.thao, { unitId: A003, startDate: d(5), endDate: d(7), reason: "Sơn lại tường (DEMO)" });

  // Sự kiện từ nguồn demo: một booking mới hợp lệ và một booking trùng đêm (xung đột)
  const nowIso = new Date().toISOString();
  await ingestBookingEvent(org.id, demoConn, {
    externalEventId: "demo-ev-1",
    type: "booking.upsert",
    externalRef: "DEMO-HM1011",
    sourceVersion: 1,
    occurredAt: nowIso,
    booking: { listingExternalId: "DEMO-AB-C001", checkInDate: d(8), checkOutDate: d(10), guestName: "Khách Demo kênh", adults: 2 },
  });
  await ingestBookingEvent(org.id, demoConn, {
    externalEventId: "demo-ev-2",
    type: "booking.upsert",
    externalRef: "DEMO-HM1012",
    sourceVersion: 1,
    occurredAt: nowIso,
    booking: { listingExternalId: "DEMO-AB-A002", checkInDate: d(1), checkOutDate: d(2), guestName: "Khách Demo trùng lịch", adults: 2 },
  });

  await markDemo(org.id);
  const stats = await drainOutbox(handlers);
  console.log("Worker lượt đầu:", stats);

  // Việc dọn ở vài trạng thái
  const tasks = await query<{ id: string; unit_code: string; service_date: string }>(
    "SELECT t.id, u.code AS unit_code, t.service_date FROM cleaning_tasks t JOIN units u ON u.id = t.unit_id WHERE t.org_id = $1 AND t.status = 'pending_assignment' ORDER BY t.service_date, u.code",
    [org.id],
  );
  const byCode = (code: string) => tasks.find((t) => t.unit_code === code && t.service_date === today);
  const thao = actors.thao;
  const tA23 = tasks.filter((t) => (t.unit_code === "A002" || t.unit_code === "A003") && t.service_date === today);
  for (const t of tA23) {
    await assignTask(thao, t.id, { userId: actors["cleaner.a"].userId! });
    await acceptTask(actors["cleaner.a"], t.id);
  }
  if (tA23[0]) await startTask(actors["cleaner.a"], tA23[0].id);
  const tA1 = byCode("A001");
  if (tA1) {
    await assignTask(thao, tA1.id, { userId: actors["cleaner.a"].userId! });
  }
  const tC = byCode("C001");
  if (tC) await assignTask(thao, tC.id, { userId: actors["cleaner.b"].userId! });

  await drainOutbox(handlers);
  await markDemo(org.id);

  // Gia hạn đã duyệt khi việc đã được nhận → việc phải chờ xác nhận thay đổi (mô phỏng quy tắc)
  const counts = await queryOne<{ bookings: number; tasks: number; conflicts: number; crs: number }>(
    `SELECT (SELECT count(*)::int FROM bookings WHERE org_id = $1) AS bookings,
            (SELECT count(*)::int FROM cleaning_tasks WHERE org_id = $1) AS tasks,
            (SELECT count(*)::int FROM inventory_conflicts WHERE org_id = $1 AND status = 'open') AS conflicts,
            (SELECT count(*)::int FROM change_requests WHERE org_id = $1 AND status = 'pending') AS crs`,
    [org.id],
  );
  console.log("Đã tạo dữ liệu DEMO:", counts);
  console.log(`Đăng nhập: ${users.map((u) => u[0]).join(", ")}`);
  console.log(process.env.DEMO_PASSWORD ? "Mật khẩu: giá trị DEMO_PASSWORD đã đặt" : `Mật khẩu chung (chỉ DEMO): ${DEMO_PASSWORD}`);
  void b2;
  void b7;
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error("Seed lỗi:", error);
    await closePool();
    process.exit(1);
  });
