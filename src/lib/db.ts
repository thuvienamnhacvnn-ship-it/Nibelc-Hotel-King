import pg from "pg";
import { requireEnv } from "./env";

// date (ngày vận hành) giữ nguyên chuỗi YYYY-MM-DD — không để pg đổi sang Date theo múi giờ máy chủ.
pg.types.setTypeParser(1082, (v) => v);
// bigint (tiền theo cent) trả về number khi an toàn, tránh chuỗi lẫn vào phép tính.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`Giá trị bigint vượt giới hạn an toàn: ${v}`);
  return n;
});

export type Queryable = Pick<pg.PoolClient, "query">;

const globalForPool = globalThis as unknown as { __nibelcPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!globalForPool.__nibelcPool) {
    globalForPool.__nibelcPool = new pg.Pool({
      connectionString: requireEnv("DATABASE_URL"),
      max: Number(process.env.DB_POOL_MAX ?? 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForPool.__nibelcPool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Queryable = pool(),
): Promise<T[]> {
  const result = await client.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Queryable = pool(),
): Promise<T | null> {
  const rows = await query<T>(sql, params, client);
  return rows[0] ?? null;
}

/**
 * Chạy fn trong một giao dịch. MỌI truy vấn bên trong phải dùng `tx` được truyền vào —
 * gọi pool() bên trong giao dịch sẽ chờ kết nối khác và có thể treo (PGlite xếp hàng theo giao dịch).
 */
export async function withTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  let failure: unknown = null;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failure = error;
    try {
      await client.query("ROLLBACK");
    } catch {
      // kết nối đã hỏng — lỗi gốc quan trọng hơn
    }
    throw error;
  } finally {
    // Có lỗi thì huỷ luôn kết nối thay vì trả về pool: PGlite qua socket có thể lệch giao thức sau một câu lệnh
    // có tham số bị lỗi (đã tái hiện 16/09/2026), và kết nối lệch sẽ trả kết quả của câu trước cho câu sau.
    client.release(failure ? (failure instanceof Error ? failure : new Error(String(failure))) : undefined);
  }
}

export async function closePool() {
  if (globalForPool.__nibelcPool) {
    await globalForPool.__nibelcPool.end();
    globalForPool.__nibelcPool = undefined;
  }
}
