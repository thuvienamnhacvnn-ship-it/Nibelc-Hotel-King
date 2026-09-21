/**
 * Đặt mật khẩu cho một tài khoản ĐÃ CÓ trong bảng users (tài khoản thật nhập tay còn mang
 * chuỗi đánh dấu 'chua-cap-mat-khau' nên chưa đăng nhập được).
 *
 *   npx tsx scripts/set-password.ts --email <email> [--org <slug>] [--generate | --password <chuoi>] [--allow-demo]
 *
 * Quy tắc:
 *   - --generate sinh mật khẩu mạnh và in ĐÚNG MỘT LẦN; không ghi vào nhật ký, không lưu ở đâu ngoài băm trong DB.
 *   - --password <chuoi> để tự đặt (tối thiểu 10 ký tự). Chuỗi này nằm trong lịch sử dòng lệnh của máy —
 *     ưu tiên --generate; dùng --password thì đổi lại sau khi người kia đăng nhập được.
 *   - Từ chối tài khoản không tồn tại, mật khẩu dưới 10 ký tự, và tổ chức/tài khoản DEMO (trừ khi --allow-demo).
 *   - Ghi audit_log hành động user.set_password (email + ai chạy script, KHÔNG có mật khẩu).
 *   - Huỷ mọi phiên đang mở của tài khoản đó: mật khẩu cũ mất tác dụng ngay.
 */
import os from "node:os";
import { loadLocalEnv } from "../src/lib/env";

loadLocalEnv();

const { closePool } = await import("../src/lib/db");
const { generatePassword, setPasswordForEmail } = await import("../src/modules/auth/user-admin");
const { ROLE_LABELS } = await import("../src/modules/auth/permissions");

const USAGE = "Dùng: npx tsx scripts/set-password.ts --email <email> [--org <slug>] [--generate | --password <chuoi>] [--allow-demo]";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const email = arg("email");
  const given = arg("password");
  const generate = flag("generate");
  if (!email || email.startsWith("--") || !email.includes("@")) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (generate === !!given) {
    console.error("Chọn đúng một trong hai: --generate hoặc --password <chuoi>.");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const password = generate ? generatePassword() : given!;
  const result = await setPasswordForEmail({
    email,
    orgSlug: arg("org") ?? null,
    password,
    allowDemo: flag("allow-demo"),
    setBy: `${os.userInfo().username}@${os.hostname()}`,
  });

  console.log(`Tổ chức:   ${result.orgSlug}${result.isDemo ? " (DEMO)" : ""}`);
  console.log(`Tài khoản: ${result.fullName} <${result.email}> — ${ROLE_LABELS[result.role] ?? result.role}`);
  console.log(`Phiên đã huỷ: ${result.sessionsRevoked} (mật khẩu cũ hết tác dụng ngay)`);
  if (generate) {
    console.log("");
    console.log(`Mật khẩu (chỉ hiện MỘT lần, không lưu ở đâu): ${password}`);
    console.log("Gửi RIÊNG cho đúng người đó và bảo họ đổi lại ở mục “Tài khoản của tôi” sau khi đăng nhập.");
  } else {
    console.log("Đã đặt mật khẩu bạn cung cấp (không in lại ra đây).");
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closePool();
}
