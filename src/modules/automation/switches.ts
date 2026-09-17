import type { Queryable } from "@/lib/db";
import { pool } from "@/lib/db";

/**
 * Công tắc dừng tự động theo tổ chức / trợ lý / kênh (đặc tả: "nút dừng automation theo agent/kênh/tổ chức").
 * Mặc định AN TOÀN: chưa có bản ghi nào cho một trợ lý hay kênh gửi tin ⇒ coi như ĐANG DỪNG,
 * trừ khi `defaultPaused: false` được truyền cho những việc chỉ đọc/tính toán.
 */
export type SwitchScope = "org" | "agent" | "channel";

export const AGENT_KEYS = ["booking", "cleaning", "guest", "guest_ai", "manager"] as const;
export const CHANNEL_KEYS = ["whatsapp_staff", "whatsapp_guest", "report_delivery"] as const;

export async function isPaused(
  orgId: string,
  checks: { scope: SwitchScope; key: string }[],
  opts: { defaultPaused?: boolean; client?: Queryable } = {},
): Promise<{ paused: boolean; reason: string | null }> {
  const q = opts.client ?? pool();
  const { rows } = await q.query<{ scope: string; scope_key: string; paused: boolean; reason: string | null }>(
    "SELECT scope, scope_key, paused, reason FROM automation_switches WHERE org_id = $1",
    [orgId],
  );
  const find = (scope: string, key: string) => rows.find((r) => r.scope === scope && r.scope_key === key);
  const org = find("org", "");
  if (org?.paused) return { paused: true, reason: org.reason ?? "Toàn bộ tự động của tổ chức đang dừng" };
  for (const c of checks) {
    const row = find(c.scope, c.key);
    if (!row) {
      if (opts.defaultPaused ?? true) return { paused: true, reason: `Chưa bật ${c.scope}:${c.key}` };
      continue;
    }
    if (row.paused) return { paused: true, reason: row.reason ?? `${c.scope}:${c.key} đang dừng` };
  }
  return { paused: false, reason: null };
}
