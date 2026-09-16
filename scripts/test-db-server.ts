/**
 * PGlite trong bộ nhớ cho bộ kiểm thử, chạy thành tiến trình riêng.
 * (Chạy PGlite ngay trong tiến trình chính của vitest làm lệch giao thức Postgres sau khi một câu lệnh lỗi —
 *  đã tái hiện 16/09/2026; tách tiến trình thì không gặp.)
 */
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.argv[2]);
if (!port) {
  console.error("Cần số cổng");
  process.exit(1);
}
const db = await PGlite.create({ extensions: { btree_gist } });
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 100 });
await server.start();
console.log(`READY ${port}`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);
