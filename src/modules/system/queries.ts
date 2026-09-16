import { queryOne } from "@/lib/db";

export async function orgInfo(orgId: string) {
  return queryOne<{ id: string; name: string; timezone: string; currency: string; is_demo: boolean }>(
    "SELECT id, name, timezone, currency, is_demo FROM organizations WHERE id = $1",
    [orgId],
  );
}

/**
 * Số đếm nhỏ trên tab điện thoại. Chỉ đếm mục người xem có quyền mở — không để lộ số liệu ngoài quyền.
 * Hộp thư: hội thoại còn tin chưa đọc. Duyệt: yêu cầu thay đổi chờ + xung đột lịch đang mở.
 */
export async function navBadges(actor: { orgId: string; permissions: ReadonlySet<string> }): Promise<Record<string, number>> {
  const inbox = actor.permissions.has("inbox.view");
  const review = ["booking.request_change", "conflict.resolve", "booking.view"].some((p) => actor.permissions.has(p));
  if (!inbox && !review) return {};
  const row = await queryOne<{ unread: number; review: number }>(
    `SELECT CASE WHEN $2 THEN (SELECT count(*)::int FROM conversations WHERE org_id = $1 AND unread_count > 0) ELSE 0 END AS unread,
            CASE WHEN $3 THEN (SELECT count(*)::int FROM change_requests WHERE org_id = $1 AND status = 'pending')
                            + (SELECT count(*)::int FROM inventory_conflicts WHERE org_id = $1 AND status = 'open') ELSE 0 END AS review`,
    [actor.orgId, inbox, review],
  );
  const out: Record<string, number> = {};
  if (row?.unread) out["/hop-thu"] = row.unread;
  if (row?.review) out["/duyet"] = row.review;
  return out;
}

/** Worker còn sống không (nhịp trong 60 giây gần nhất) + số sự kiện nền đang chờ/hỏng của tổ chức. */
export async function backgroundStatus(orgId: string) {
  const row = await queryOne<{ last_beat_at: Date | null; pending: number; dead: number; oldest_pending_at: Date | null }>(
    `SELECT (SELECT last_beat_at FROM system_heartbeats WHERE name = 'worker') AS last_beat_at,
            (SELECT count(*)::int FROM outbox_events WHERE org_id = $1 AND status IN ('pending','processing')) AS pending,
            (SELECT count(*)::int FROM outbox_events WHERE org_id = $1 AND status = 'dead') AS dead,
            (SELECT min(created_at) FROM outbox_events WHERE org_id = $1 AND status IN ('pending','processing')) AS oldest_pending_at`,
    [orgId],
  );
  const lastBeat = row?.last_beat_at ? new Date(row.last_beat_at) : null;
  return {
    workerAlive: !!lastBeat && Date.now() - lastBeat.getTime() < 60_000,
    lastBeat,
    pending: row?.pending ?? 0,
    dead: row?.dead ?? 0,
    oldestPendingAt: row?.oldest_pending_at ?? null,
  };
}
