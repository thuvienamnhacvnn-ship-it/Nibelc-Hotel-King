/**
 * Cầu nối giao thức Postgres → PGlite cho máy dev/kiểm thử.
 *
 * Vì sao không dùng thẳng @electric-sql/pglite-socket (0.2.11): thư viện đó đẩy TỪNG thông điệp giao thức
 * (Parse, Bind, Execute, Sync…) vào PGlite riêng lẻ. Khi một câu lệnh có tham số bị lỗi, phần phản hồi còn sót
 * lại được gửi cho lời gọi kế tiếp — có thể thuộc kết nối KHÁC — nên request chạy song song nhận kết quả lệch
 * (404/401/500 sai). Đã tái hiện 16/09/2026.
 *
 * Thêm hai lỗi của PGlite 0.5.8 khi một lệnh có tham số bị lỗi (đã soi từng byte):
 *   - execProtocolRawStream trả vùng nhớ cũ (rác) → dùng execProtocolRaw;
 *   - execProtocolRaw trả hai ReadyForQuery liền nhau → client coi cái thừa là kết thúc của câu SAU.
 *     Bỏ các ReadyForQuery liền kề, giữ cái cuối.
 *
 * Ở đây mỗi kết nối gom thông điệp tới ranh giới Sync / Query / Terminate rồi gửi cả cụm một lần,
 * nên PGlite tự bỏ qua đúng phần sau lỗi như Postgres thật. Hàng đợi toàn cục chỉ cho một cụm chạy
 * tại một thời điểm; khi một kết nối đang mở giao dịch, chỉ cụm của kết nối đó được chạy.
 */
import net from "node:net";
import type { PGlite } from "@electric-sql/pglite";

const SSL_REQUEST = 80877103;
const CANCEL_REQUEST = 80877102;
const GSSENC_REQUEST = 80877104;
const IDLE_IN_TX_MS = 60_000;

interface Batch {
  conn: Conn;
  data: Uint8Array;
  done: () => void;
}

interface Conn {
  id: number;
  socket: net.Socket;
  buffer: Buffer;
  pending: Buffer[];
  started: boolean;
  closed: boolean;
}

export async function startPgliteServer(db: PGlite, opts: { host: string; port: number; log?: (msg: string) => void }) {
  const log = opts.log ?? (() => undefined);
  const queue: Batch[] = [];
  let running = false;
  let txOwner: Conn | null = null;
  let txTimer: NodeJS.Timeout | null = null;
  let nextId = 1;

  function armTxTimer() {
    if (txTimer) clearTimeout(txTimer);
    txTimer = null;
    if (!txOwner) return;
    const owner = txOwner;
    txTimer = setTimeout(() => {
      // Kết nối giữ giao dịch quá lâu mà không gửi gì: chặn mọi kết nối khác. Huỷ để hệ thống không treo.
      log(`kết nối #${owner.id} giữ giao dịch quá ${IDLE_IN_TX_MS / 1000}s — rollback và đóng`);
      owner.socket.destroy();
    }, IDLE_IN_TX_MS);
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        let idx = 0;
        if (txOwner && db.isInTransaction()) {
          idx = queue.findIndex((b) => b.conn === txOwner);
          if (idx === -1) break; // chờ kết nối đang giữ giao dịch gửi cụm tiếp theo
        }
        const [batch] = queue.splice(idx, 1);
        if (batch.conn.closed) {
          batch.done();
          continue;
        }
        try {
          const out = await db.runExclusive(() => db.execProtocolRaw(batch.data));
          if (!batch.conn.closed && out.length) batch.conn.socket.write(dropDuplicateReadyForQuery(Buffer.from(out)));
        } catch (error) {
          log(`lỗi thực thi cụm của #${batch.conn.id}: ${(error as Error).message}`);
          batch.conn.socket.destroy();
        }
        txOwner = db.isInTransaction() ? batch.conn : null;
        armTxTimer();
        batch.done();
      }
    } finally {
      running = false;
    }
  }

  function enqueue(conn: Conn, data: Buffer) {
    return new Promise<void>((resolve) => {
      queue.push({ conn, data: new Uint8Array(data), done: resolve });
      void pump();
    });
  }

  async function onClose(conn: Conn) {
    if (conn.closed) return;
    conn.closed = true;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].conn === conn) queue.splice(i, 1)[0].done();
    if (txOwner === conn) {
      await db.runExclusive(async () => {
        if (db.isInTransaction()) await db.exec("ROLLBACK");
      });
      txOwner = null;
      armTxTimer();
    }
    void pump();
  }

  function takeMessages(conn: Conn): Buffer[] {
    const ready: Buffer[] = [];
    for (;;) {
      const buf = conn.buffer;
      if (!conn.started) {
        if (buf.length < 8) break;
        const len = buf.readInt32BE(0);
        if (buf.length < len) break;
        const code = buf.readInt32BE(4);
        conn.buffer = buf.subarray(len);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
          conn.socket.write("N");
          continue;
        }
        if (code === CANCEL_REQUEST) continue;
        conn.started = true;
        ready.push(buf.subarray(0, len)); // thông điệp khởi động là một cụm riêng
        continue;
      }
      if (buf.length < 5) break;
      const type = buf[0];
      const len = buf.readInt32BE(1) + 1;
      if (buf.length < len) break;
      const msg = buf.subarray(0, len);
      conn.buffer = buf.subarray(len);
      if (type === 0x58 /* X: Terminate */) {
        conn.socket.end();
        break;
      }
      conn.pending.push(msg);
      // Ranh giới cụm: Sync (S), truy vấn đơn (Q), Flush (H)
      if (type === 0x53 || type === 0x51 || type === 0x48) {
        ready.push(Buffer.concat(conn.pending));
        conn.pending = [];
      }
    }
    return ready;
  }

  const server = net.createServer((socket) => {
    const conn: Conn = { id: nextId++, socket, buffer: Buffer.alloc(0), pending: [], started: false, closed: false };
    socket.setNoDelay(true);
    let chain = Promise.resolve();
    socket.on("data", (chunk) => {
      conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, chunk]) : chunk;
      const batches = takeMessages(conn);
      // Giữ đúng thứ tự cụm trong một kết nối.
      for (const b of batches) chain = chain.then(() => enqueue(conn, b));
    });
    socket.on("error", () => void onClose(conn));
    socket.on("close", () => void onClose(conn));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  return {
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Bỏ ReadyForQuery (Z) đứng liền trước một ReadyForQuery khác. */
export function dropDuplicateReadyForQuery(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  let lastWasZ = false;
  while (i + 5 <= buf.length) {
    const type = buf[i];
    const len = buf.readInt32BE(i + 1) + 1;
    const msg = buf.subarray(i, i + len);
    if (type === 0x5a && lastWasZ) parts.pop();
    parts.push(msg);
    lastWasZ = type === 0x5a;
    i += len;
  }
  if (i < buf.length) parts.push(buf.subarray(i));
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}
