/**
 * Tạo connector WhatsApp tổng đài (Evolution API) cho một tổ chức — trạng thái 'testing', không chứa khoá.
 * Chạy nhiều lần không tạo trùng.
 *
 *   npx tsx scripts/seed-whatsapp-connector.ts --org <slug>
 *
 * Sau đó: sinh token webhook bằng scripts/connector-webhook-secret.ts; đặt EVOLUTION_API_URL / EVOLUTION_API_KEY /
 * EVOLUTION_INSTANCE trong env máy chủ. Thiếu env thì mọi lần gửi ghi 'failed: not_configured'.
 */
import { loadLocalEnv } from "../src/lib/env";

loadLocalEnv();

const { closePool, queryOne } = await import("../src/lib/db");

const LABEL = "Tổng đài +36 70 409 2957";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("org");
  if (!slug) {
    console.error("Dùng: npx tsx scripts/seed-whatsapp-connector.ts --org <slug>");
    process.exitCode = 1;
    return;
  }
  const org = await queryOne<{ id: string }>("SELECT id FROM organizations WHERE slug = $1", [slug]);
  if (!org) {
    console.error(`Không tìm thấy tổ chức ${slug}.`);
    process.exitCode = 1;
    return;
  }
  const existing = await queryOne<{ id: string; status: string }>("SELECT id, status FROM connector_accounts WHERE org_id = $1 AND channel = 'whatsapp' AND label = $2", [org.id, LABEL]);
  if (existing) {
    console.log(`Đã có connector "${LABEL}" (${existing.status}): ${existing.id}`);
    return;
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO connector_accounts (org_id, channel, label, status, capabilities, config)
     VALUES ($1, 'whatsapp', $2, 'testing', $3, $4) RETURNING id`,
    [
      org.id,
      LABEL,
      JSON.stringify({ messages: true, calling: false }),
      JSON.stringify({ provider: "evolution_api_v2", phone: "+36 70 409 2957", note: "Khoá API chỉ đặt trong env EVOLUTION_API_KEY; giới hạn 1 tin/3 giây." }),
    ],
  );
  console.log(`Đã tạo connector "${LABEL}" (testing): ${row!.id}`);
}

try {
  await main();
} finally {
  await closePool();
}
