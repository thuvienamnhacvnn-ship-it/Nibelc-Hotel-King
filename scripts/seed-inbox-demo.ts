/**
 * Dữ liệu DEMO cho hộp thư (tổ chức nibelc-demo): connector WhatsApp DEMO, vài hội thoại khách + một nhóm nội bộ.
 * Tin đi qua đúng đường nhận tin thật (ingestInboundMessage) nên bot nháp / handoff / khớp booking chạy như vận hành.
 * Mã tin cố định ⇒ chạy lại không tạo trùng. Không gửi gì ra ngoài (connector demo luôn bị chặn gửi).
 *
 *   npx tsx scripts/seed-inbox-demo.ts
 */
import { loadLocalEnv } from "../src/lib/env";

loadLocalEnv();

const { closePool, queryOne } = await import("../src/lib/db");
const { ingestInboundMessage } = await import("../src/modules/inbox/service");
const { formatDateVi } = await import("../src/lib/time");

const LABEL = "WhatsApp DEMO (hộp thư)";

async function main() {
  const org = await queryOne<{ id: string }>("SELECT id FROM organizations WHERE slug = 'nibelc-demo'");
  if (!org) {
    console.error("Chưa có tổ chức nibelc-demo — chạy seed DEMO chính trước.");
    process.exitCode = 1;
    return;
  }
  let connector = await queryOne<{ id: string }>("SELECT id FROM connector_accounts WHERE org_id = $1 AND channel = 'whatsapp' AND label = $2", [org.id, LABEL]);
  if (!connector) {
    connector = await queryOne<{ id: string }>(
      "INSERT INTO connector_accounts (org_id, channel, label, status, capabilities) VALUES ($1,'whatsapp',$2,'demo',$3) RETURNING id",
      [org.id, LABEL, JSON.stringify({ messages: true, calling: false })],
    );
  }
  const connectorId = connector!.id;
  const t0 = Date.now() - 60 * 60_000;
  const msgs: { thread: string; id: string; name: string; sender?: string; text: string; minute: number }[] = [
    { thread: "36000000101@s.whatsapp.net", id: "DEMO-INBOX-101-1", name: "Khách DEMO Anna", text: "Hi, what time is check-in?", minute: 0 },
    { thread: "36000000102@s.whatsapp.net", id: "DEMO-INBOX-102-1", name: "Khách DEMO Ben", text: "Hello, I arrive tonight. What is the door code?", minute: 5 },
    { thread: "36000000103@s.whatsapp.net", id: "DEMO-INBOX-103-1", name: "Khách DEMO Chi", text: "The shower is broken and there is a leak in the bathroom.", minute: 10 },
    { thread: "120363000000000999@g.us", id: "DEMO-INBOX-G1-1", name: "Thành viên DEMO", sender: "36000000201@s.whatsapp.net", text: "Nhóm DEMO: phòng A001 cần thêm khăn trước 15:00.", minute: 15 },
  ];

  // Khách DEMO gửi đúng mã + tên + ngày của một booking DEMO ⇒ hội thoại được gắn booking (verification matched).
  const b = await queryOne<{ external_ref: string; full_name: string; check_in_date: string }>(
    `SELECT b.external_ref, g.full_name, b.check_in_date FROM bookings b JOIN guests g ON g.id = b.guest_id
      WHERE b.org_id = $1 AND b.is_demo AND b.external_ref IS NOT NULL AND b.booking_status <> 'cancelled' ORDER BY b.check_in_date DESC LIMIT 1`,
    [org.id],
  );
  if (b) {
    msgs.push({
      thread: "36000000104@s.whatsapp.net",
      id: "DEMO-INBOX-104-1",
      name: "Khách DEMO Dora",
      text: `Hi, my booking is ${b.external_ref}, name ${b.full_name}, arriving ${formatDateVi(b.check_in_date)}. Is breakfast included?`,
      minute: 20,
    });
  }

  const counts: Record<string, number> = {};
  for (const m of msgs) {
    const res = await ingestInboundMessage({
      orgId: org.id,
      connectorId,
      channel: "whatsapp",
      threadId: m.thread,
      externalMessageId: m.id,
      senderHandle: m.sender ?? m.thread,
      senderName: m.name,
      text: m.text,
      occurredAt: new Date(t0 + m.minute * 60_000),
      isDemo: true,
    });
    const key = res.status === "duplicate" ? "trùng (đã có)" : `mới → ${res.bot?.action ?? "không bot"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(`Connector DEMO: ${connectorId}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
}

try {
  await main();
} finally {
  await closePool();
}
