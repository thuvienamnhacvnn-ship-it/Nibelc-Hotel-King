/**
 * Dữ liệu DEMO cho Agent Manager (tổ chức nibelc-demo): Leader DEMO (cấp cuối), người trực, 3 mẫu tin NHÁP, 1 đăng ký báo cáo TẮT.
 * Chạy lặp được — bản ghi đã có thì giữ nguyên, không tạo trùng. Không bật công tắc nào, không gửi gì.
 *
 * Chạy: npx tsx scripts/seed-manager-demo.ts
 */
import { loadLocalEnv } from "../src/lib/env";

loadLocalEnv();

const { closePool, query, queryOne } = await import("../src/lib/db");
const { hashPassword } = await import("../src/modules/auth/password");

// Cùng quy ước seed chính: production phải đặt DEMO_PASSWORD riêng.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "Demo-Nibelc-2026";
if (process.env.NODE_ENV === "production" && !process.env.DEMO_PASSWORD) {
  console.error("Đang ở production: đặt DEMO_PASSWORD riêng trước khi seed.");
  process.exit(1);
}

async function main() {
  const org = await queryOne<{ id: string }>("SELECT id FROM organizations WHERE slug = 'nibelc-demo'");
  if (!org) {
    console.log("Chưa có tổ chức nibelc-demo — chạy seed DEMO trước.");
    return;
  }
  let leaderCreated = 0;
  const existingLeader = await queryOne<{ id: string }>("SELECT id FROM users WHERE lower(email) = 'ngoc.leader@demo.nibelc.local'");
  if (!existingLeader) {
    await query(
      "INSERT INTO users (org_id, email, full_name, role, password_hash, is_demo) VALUES ($1, 'ngoc.leader@demo.nibelc.local', 'Ngọc — Leader (DEMO)', 'leader', $2, true)",
      [org.id, await hashPassword(DEMO_PASSWORD)],
    );
    leaderCreated = 1;
  }

  const users = await query<{ id: string; email: string; role: string }>("SELECT id, email, role FROM users WHERE org_id = $1 AND is_demo", [org.id]);
  const byEmail = (local: string) => users.find((u) => u.email === `${local}@demo.nibelc.local`)?.id ?? null;
  const thao = byEmail("thao");
  const budapest = byEmail("budapest");
  const top = byEmail("ngoc.leader") ?? byEmail("admin");
  const admin = byEmail("admin");
  const ngoc = byEmail("ngoc");

  const contacts: [string, number, string | null][] = [
    ["guest_support", 0, thao],
    ["guest_support", 1, budapest],
    ["guest_support", 2, top],
    ["maintenance", 0, thao],
    ["maintenance", 1, budapest],
    ["maintenance", 2, top],
    ["cleaning", 0, thao],
    ["cleaning", 1, budapest],
    ["technical", 0, admin],
  ];
  // Lần chạy trước (chưa có Leader DEMO) đặt quản trị ở cấp cuối — chuyển cấp cuối sang Leader.
  let moved = 0;
  if (top && admin && top !== admin) {
    moved = (await query("DELETE FROM escalation_contacts WHERE org_id = $1 AND user_id = $2 AND level = 2 AND purpose IN ('guest_support','maintenance') RETURNING id", [org.id, admin])).length;
  }
  let added = 0;
  for (const [purpose, level, userId] of contacts) {
    if (!userId) continue;
    const r = await query(
      "INSERT INTO escalation_contacts (org_id, purpose, level, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, purpose, level, user_id) DO NOTHING RETURNING id",
      [org.id, purpose, level, userId],
    );
    added += r.length;
  }

  const templates: [string, string][] = [
    ["ticket_escalation", "[DEMO] Việc khẩn {{priority}} chưa ai nhận ({{overdue_minutes}} phút): {{summary}}. Cấp {{level}}. Mở: {{link}}"],
    ["daily_report", "[DEMO] {{kind_label}} {{date}}\n{{summary}}\nChi tiết: {{link}}"],
    ["handoff_request", "[DEMO] Khách cần người thật hỗ trợ: {{reason}}. Cấp {{level}}. Nhận tại: {{link}}"],
  ];
  let tpl = 0;
  for (const [key, body] of templates) {
    const r = await query<{ id: string }>(
      "INSERT INTO message_templates (org_id, key, language, body, status) VALUES ($1,$2,'vi',$3,'draft') ON CONFLICT (org_id, key, language) DO NOTHING RETURNING id",
      [org.id, key, body],
    );
    tpl += r.length;
  }

  let subs = 0;
  if (ngoc) {
    const r = await query(
      "INSERT INTO report_subscriptions (org_id, user_id, kind, channel, send_time, enabled) VALUES ($1,$2,'morning','whatsapp','08:00',false) ON CONFLICT (org_id, user_id, kind, channel) DO NOTHING RETURNING id",
      [org.id, ngoc],
    );
    subs = r.length;
  }
  console.log(`Agent Manager DEMO: +${leaderCreated} Leader, -${moved} quản trị khỏi cấp cuối, +${added} người trực, +${tpl} mẫu tin nháp, +${subs} đăng ký báo cáo (tắt). Công tắc không đổi.`);
}

try {
  await main();
} finally {
  await closePool();
}
