/**
 * Database thử riêng cho bộ kiểm thử: PGlite trong bộ nhớ ở một tiến trình con, cổng trống ngẫu nhiên.
 * Không bao giờ chạm database dev (.pgdata).
 */
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function startServer(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join("scripts", "test-db-server.ts"), String(port)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      cwd: process.cwd(),
    });
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Database thử không khởi động được sau 60s:\n${output}`)), 60_000);
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.includes(`READY ${port}`)) {
        clearTimeout(timer);
        resolve(Object.assign(child, { port }));
      }
    });
    child.stderr!.on("data", (chunk) => (output += chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Database thử thoát sớm (mã ${code}):\n${output}`));
    });
  });
}

export default async function setup() {
  // TEST_DATABASE_URL: chạy trên PostgreSQL thật (database RỖNG dành riêng cho test, sẽ bị ghi dữ liệu thử).
  const external = process.env.TEST_DATABASE_URL;
  const child = external ? null : await startServer(await freePort());
  process.env.DATABASE_URL = external ?? `postgresql://postgres:postgres@127.0.0.1:${(child as ChildProcess & { port: number }).port}/postgres`;
  process.env.DB_POOL_MAX = "6";

  const { runMigrations } = await import("../src/lib/migrations");
  const { closePool } = await import("../src/lib/db");
  await runMigrations(() => undefined);
  await closePool();

  return async () => {
    if (!child) return;
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
  };
}
