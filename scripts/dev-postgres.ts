/**
 * Postgres cho máy phát triển không cài được Postgres/Docker.
 *
 * PGlite là bản Postgres biên dịch sang WASM, chạy trong tiến trình Node.
 * `scripts/pglite-server.ts` bọc nó sau giao thức mạng của Postgres, nên công cụ migrate,
 * worker và ứng dụng đều kết nối như tới một server
 * Postgres bình thường — cùng một file migration chạy được ở cả hai nơi.
 *
 *   npm run db:dev            # giữ terminal này mở
 *   npm run db:migrate        # ở terminal khác
 *   npm run db:seed
 *
 * Giới hạn: PGlite chỉ cho một tiến trình mở một thư mục dữ liệu tại một thời
 * điểm, nên đừng chạy hai lệnh `db:dev` cùng lúc. Production dùng
 * PostgreSQL thật — đây chỉ là lối đi cho máy bị chặn cài Postgres.
 *
 * Hai biến môi trường:
 *   DEV_PG_PORT      — cổng (mặc định 55480)
 *   DEV_PG_DATA_DIR  — thư mục dữ liệu (mặc định `<cwd>/.pgdata`). Database tạm
 *                      cho một lượt test/worktree PHẢI đặt biến này ra ngoài repo.
 *
 * Hai chốt chặn, cả hai chạy TRƯỚC khi mở PGlite — vì PGlite không tự khoá thư
 * mục dữ liệu: tiến trình thứ hai mở cùng `.pgdata` rồi mới hỏng ở bước nghe cổng
 * là đã kịp chạm vào dữ liệu. Database dev dùng chung từng hỏng theo đúng kiểu
 * "nhận kết nối rồi cắt ngay" khi có nhiều tiến trình cùng dựng PGlite.
 *   1. File khoá `<thư mục dữ liệu>.lock` ghi PID. Tiến trình đó còn sống ⇒ từ chối.
 *   2. Cổng đã có người nghe ⇒ từ chối. Không thì lệnh migrate/test chạy sau sẽ
 *      âm thầm đổ vào database của tiến trình đang giữ cổng đó.
 */
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { startPgliteServer } from "./pglite-server";
import fs from "fs";
import net from "net";
import path from "path";

const PORT = Number(process.env.DEV_PG_PORT ?? 55480);
const DATA_DIR = path.resolve(process.env.DEV_PG_DATA_DIR ?? path.join(process.cwd(), ".pgdata"));
// Đặt cạnh thư mục chứ không trong đó: có khoá được cả khi thư mục chưa tồn tại.
const LOCK_FILE = `${DATA_DIR}.lock`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: tiến trình tồn tại nhưng không có quyền gửi tín hiệu — vẫn là còn sống.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Giành khoá thư mục dữ liệu. Trả về false nếu một tiến trình còn sống đang giữ. */
function acquireLock(): boolean {
  const content = `${process.pid}\n${PORT}\n${new Date().toISOString()}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(LOCK_FILE, content, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(fs.readFileSync(LOCK_FILE, "utf8").split("\n")[0]);
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
        console.error(
          `Thư mục dữ liệu ${DATA_DIR} đang được tiến trình ${holder} giữ (${LOCK_FILE}). ` +
            "Không mở lần thứ hai — hai tiến trình PGlite cùng một thư mục dữ liệu là hỏng dữ liệu.",
        );
        return false;
      }
      // Khoá của tiến trình đã chết (tắt ngang, mất điện): gỡ rồi thử lại một lần.
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, "utf8").split("\n")[0]) === process.pid) {
      fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch {
    // Không còn file khoá thì thôi.
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function main() {
  if (!acquireLock()) process.exit(1);
  process.on("exit", releaseLock);

  if (!(await portIsFree(PORT))) {
    console.error(
      `Cổng ${PORT} đã có tiến trình khác nghe. Không mở PGlite — lệnh migrate/test sau đó ` +
        "sẽ đổ nhầm vào database của tiến trình đang giữ cổng. Đặt DEV_PG_PORT khác.",
    );
    process.exit(1);
  }

  const db = await PGlite.create({ dataDir: DATA_DIR, extensions: { btree_gist } });
  // Cầu nối riêng thay cho pglite-socket — xem scripts/pglite-server.ts (lỗi lệch giao thức khi lệnh có tham số bị lỗi).
  const server = await startPgliteServer(db, { host: "127.0.0.1", port: PORT, log: (m) => console.log("[pglite]", m) });

  console.log(`PGlite đang lắng nghe giao thức Postgres tại 127.0.0.1:${PORT}`);
  console.log(`Thư mục dữ liệu: ${DATA_DIR}`);
  console.log(`DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres"`);
  console.log("Ctrl+C để dừng.");

  const stop = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error("Không khởi động được PGlite:", error);
  process.exit(1);
});
