import type { Queryable } from "@/lib/db";

/** Trạng thái vật lý, xếp từ "xấu nhất" tới "tốt nhất" — sản phẩm lấy trạng thái xấu nhất của các phòng. */
export const READINESS_ORDER = ["out_of_service", "occupied", "vacated_dirty", "cleaning", "inspection_pending", "unknown", "ready"] as const;
export type ReadinessStatus = (typeof READINESS_ORDER)[number];

export const READINESS_LABELS: Record<ReadinessStatus, string> = {
  out_of_service: "Ngừng sử dụng",
  occupied: "Có khách",
  vacated_dirty: "Khách đã đi — chưa dọn",
  cleaning: "Đang dọn",
  inspection_pending: "Chờ kiểm",
  unknown: "Chưa rõ",
  ready: "Sẵn sàng",
};

export async function setReadinessForUnit(
  tx: Queryable,
  orgId: string,
  unitId: string,
  status: ReadinessStatus,
  opts: { taskId?: string | null; userId?: string | null; note?: string | null } = {},
) {
  await tx.query(
    `INSERT INTO resource_readiness (resource_id, org_id, status, task_id, decided_by, note, updated_at)
     SELECT ur.resource_id, $1, $3, $4, $5, $6, now() FROM unit_resources ur WHERE ur.unit_id = $2
     ON CONFLICT (resource_id) DO UPDATE SET status = EXCLUDED.status, task_id = EXCLUDED.task_id,
       decided_by = EXCLUDED.decided_by, note = EXCLUDED.note, updated_at = now()`,
    [orgId, unitId, status, opts.taskId ?? null, opts.userId ?? null, opts.note ?? null],
  );
}

export function worstReadiness(statuses: string[]): ReadinessStatus {
  if (statuses.length === 0) return "unknown";
  let worst = READINESS_ORDER.length - 1;
  for (const s of statuses) {
    const idx = READINESS_ORDER.indexOf(s as ReadinessStatus);
    worst = Math.min(worst, idx === -1 ? READINESS_ORDER.indexOf("unknown") : idx);
  }
  return READINESS_ORDER[worst];
}

/** Trạng thái sẵn sàng của các sản phẩm (tổng hợp từ phòng). Phòng chưa có bản ghi = "unknown". */
export async function readinessForUnits(q: Queryable, orgId: string, unitIds: string[]): Promise<Map<string, ReadinessStatus>> {
  if (unitIds.length === 0) return new Map();
  const { rows } = await q.query<{ unit_id: string; statuses: string[] }>(
    `SELECT ur.unit_id, array_agg(coalesce(rr.status, 'unknown')) AS statuses
       FROM unit_resources ur LEFT JOIN resource_readiness rr ON rr.resource_id = ur.resource_id AND rr.org_id = $1
      WHERE ur.unit_id = ANY($2::uuid[]) GROUP BY ur.unit_id`,
    [orgId, unitIds],
  );
  return new Map(rows.map((r) => [r.unit_id, worstReadiness(r.statuses)]));
}
