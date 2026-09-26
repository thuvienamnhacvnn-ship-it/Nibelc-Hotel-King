/**
 * Nói chuyện trực tiếp với trợ lý trực nội bộ ("Dương Quá") mà KHÔNG gửi WhatsApp cho ai.
 *
 *   npx tsx scripts/hoi-tro-ly.ts "Tình hình hệ thống thế nào?"
 *   npx tsx scripts/hoi-tro-ly.ts --ten "Sếp Ngọc" "Còn thiếu gì?"
 *
 * Dùng đúng lời dặn, đúng số liệu và đúng model như lúc nó chạy thật, nên hỏi ở đây thấy gì
 * thì trên WhatsApp cũng vậy. Không ghi tin nhắn, không tốn lượt của ai, chỉ tốn tiền một lượt AI.
 */
import { closePool, queryOne } from "@/lib/db";
import { loadLocalEnv } from "@/lib/env";
import { askAssistantOnce } from "@/modules/inbox/staff-assist";

function args() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--ten");
  const asName = i >= 0 ? argv[i + 1] : undefined;
  // Không có --ten thì i = -1; phải kiểm i >= 0 trước, không thì loại nhầm tham số đầu (chính là câu hỏi).
  const question = argv
    .filter((_a, k) => i < 0 || (k !== i && k !== i + 1))
    .join(" ")
    .trim();
  return { asName, question };
}

async function main() {
  loadLocalEnv();
  const { asName, question } = args();
  if (!question) {
    console.error('Cách dùng: npx tsx scripts/hoi-tro-ly.ts [--ten "Sếp Ngọc"] "câu hỏi"');
    process.exit(2);
  }
  const org = await queryOne<{ id: string }>("SELECT id FROM organizations WHERE slug = 'nibelc'");
  if (!org) {
    console.error("Không thấy tổ chức nibelc.");
    process.exit(1);
  }
  const res = await askAssistantOnce(org.id, question, asName);
  console.log(`\n${asName ?? "Sếp Hưng"}: ${question}`);
  console.log(`\nDương Quá: ${res.reply || "(không trả lời)"}`);
  if (res.groupMessage) console.log(`\n[nó muốn đăng lên nhóm]\n${res.groupMessage}`);
  console.log(`\n--- ${res.model} · ${res.costUsd} USD · lý do: ${res.note} ---`);
  await closePool();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("LOI:", (e as Error).message);
    process.exit(1);
  });
