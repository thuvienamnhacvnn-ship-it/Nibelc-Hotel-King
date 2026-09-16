/**
 * Sinh token webhook cho một connector WhatsApp (Evolution API). Lưu BĂM sha256 vào connector_accounts.webhook_secret_hash,
 * in token đúng MỘT lần — không lưu token ở đâu khác. Chạy lại = xoay token (token cũ hết hiệu lực ngay).
 *
 *   npx tsx scripts/connector-webhook-secret.ts --connector <uuid>
 *
 * Cấu hình bên Evolution: webhook URL  https://<domain>/api/v1/webhooks/evolution/<connector-id>
 *                         header       x-webhook-token: <token>
 *                         sự kiện      MESSAGES_UPSERT, MESSAGES_UPDATE
 */
import { loadLocalEnv } from "../src/lib/env";

loadLocalEnv();

const { closePool, queryOne } = await import("../src/lib/db");
const { generateWebhookToken, hashWebhookToken } = await import("../src/modules/inbox/evolution");

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const connectorId = arg("connector");
  if (!connectorId || !/^[0-9a-f-]{36}$/i.test(connectorId)) {
    console.error("Dùng: npx tsx scripts/connector-webhook-secret.ts --connector <uuid>");
    process.exitCode = 1;
    return;
  }
  const c = await queryOne<{ id: string; label: string; channel: string; had: boolean }>(
    "SELECT id, label, channel, webhook_secret_hash IS NOT NULL AS had FROM connector_accounts WHERE id = $1",
    [connectorId],
  );
  if (!c) {
    console.error("Không tìm thấy connector.");
    process.exitCode = 1;
    return;
  }
  if (c.channel !== "whatsapp") {
    console.error(`Connector "${c.label}" không phải kênh whatsapp.`);
    process.exitCode = 1;
    return;
  }
  const token = generateWebhookToken();
  await queryOne("UPDATE connector_accounts SET webhook_secret_hash = $2, updated_at = now() WHERE id = $1", [c.id, hashWebhookToken(token)]);
  console.log(`Connector: ${c.label}`);
  if (c.had) console.log("Đã XOAY token: token cũ hết hiệu lực — cập nhật ngay bên Evolution.");
  console.log(`Webhook URL (đường dẫn): /api/v1/webhooks/evolution/${c.id}`);
  console.log("Header: x-webhook-token");
  console.log(`Token (chỉ hiện MỘT lần, không lưu ở đâu): ${token}`);
}

try {
  await main();
} finally {
  await closePool();
}
