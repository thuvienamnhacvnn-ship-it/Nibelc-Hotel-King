import fs from "node:fs";
import path from "node:path";

/**
 * Next tự đọc `.env.local`; script chạy bằng tsx thì không. Gọi hàm này ở đầu mọi script
 * để script và web dùng cùng một database — không âm thầm ghi vào nơi khác.
 */
export function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(process.cwd(), name);
    if (fs.existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}. Xem .env.example.`);
  return value;
}
