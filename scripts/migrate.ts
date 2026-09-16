/**
 * Áp các file migrations/*.sql chưa áp, theo thứ tự tên, mỗi file trong một giao dịch.
 * Bảng schema_migrations lưu tên + sha256; file đã áp mà bị sửa ⇒ dừng và báo.
 */
import { loadLocalEnv } from "../src/lib/env";
import { runMigrations } from "../src/lib/migrations";
import { closePool } from "../src/lib/db";

loadLocalEnv();

runMigrations()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error.message);
    await closePool();
    process.exit(1);
  });
