import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pool } from "./db";

/** Áp migration SQL chưa áp theo thứ tự tên. Dùng chung cho script và bộ kiểm thử. */
export async function runMigrations(log: (msg: string) => void = console.log) {
  const client = await pool().connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map(
      (await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM schema_migrations")).rows.map((r) => [r.name, r.sha256]),
    );
    const dir = path.join(process.cwd(), "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let count = 0;
    for (const file of files) {
      // Chuẩn hoá xuống dòng để checkout trên Windows/Linux cho cùng một mã băm.
      const sql = fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
      const sha = crypto.createHash("sha256").update(sql).digest("hex");
      if (applied.has(file)) {
        if (applied.get(file) !== sha) {
          throw new Error(`Migration ${file} đã áp nhưng nội dung bị sửa. Tạo migration mới thay vì sửa file cũ.`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [file, sha]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Lỗi khi áp ${file}: ${(error as Error).message}`);
      }
      log(`  ✓ ${file}`);
      count += 1;
    }
    log(count ? `Đã áp ${count} migration.` : "Database đã ở phiên bản mới nhất.");
  } finally {
    client.release();
  }
}
