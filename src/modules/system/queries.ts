import { queryOne } from "@/lib/db";

export async function orgInfo(orgId: string) {
  return queryOne<{ id: string; name: string; timezone: string; currency: string; is_demo: boolean }>(
    "SELECT id, name, timezone, currency, is_demo FROM organizations WHERE id = $1",
    [orgId],
  );
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
