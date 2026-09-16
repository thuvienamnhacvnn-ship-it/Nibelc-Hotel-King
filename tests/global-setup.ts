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
        resolve(child);
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
  const port = await freePort();
  const child = await startServer(port);
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  process.env.DB_POOL_MAX = "6";

  const { runMigrations } = await import("../src/lib/migrations");
  const { closePool } = await import("../src/lib/db");
  await runMigrations(() => undefined);
  await closePool();

  return async () => {
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
  };
}
