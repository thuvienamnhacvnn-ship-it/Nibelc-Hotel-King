import { pool, query } from "@/lib/db";
import { addDays, isValidDate, localToUtc, todayOps, tzAbbrev } from "@/lib/time";
import { type Actor, can } from "@/modules/auth/actor";
import { type ReadinessStatus, readinessForUnits } from "@/modules/cleaning/readiness";

/**
 * Lịch phòng theo đêm. Một ô = một đêm [ngày, ngày+1) theo giờ Budapest.
 * Chiếm tồn tính trên tài nguyên: nguyên căn và phòng lẻ dùng chung phòng vật lý nên chặn lẫn nhau —
 * lịch hiện quan hệ đó dạng "bị chặn bởi X" để người xem thấy vì sao một sản phẩm không bán được.
 * Phân bổ `conflict` KHÔNG giữ tồn (lõi không ghi claim) nên không gây "bị chặn bởi" cho sản phẩm khác.
 */

export const CALENDAR_DAY_OPTIONS = [1, 7, 14] as const;

export interface CalendarParams {
  start: string;
  days: 1 | 7 | 14;
  propertyId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCalendarParams(get: (key: string) => string | null | undefined, tz: string): CalendarParams {
  const rawStart = get("start");
  const rawDays = Number(get("days"));
  const rawProperty = get("property");
  return {
    start: rawStart && isValidDate(rawStart) ? rawStart : todayOps(tz),
    days: (CALENDAR_DAY_OPTIONS as readonly number[]).includes(rawDays) ? (rawDays as 1 | 7 | 14) : 7,
    propertyId: rawProperty && UUID_RE.test(rawProperty) ? rawProperty : null,
  };
}

export interface CalendarUnit {
  id: string;
  code: string;
  name: string;
  kind: "whole" | "room" | "studio";
  capacity: number;
  active: boolean;
  is_demo: boolean;
  sort_order: number;
  property_id: string;
  resource_ids: string[];
  readiness: ReadinessStatus;
}

export interface CalendarAllocation {
  allocation_id: string;
  booking_id: string;
  unit_id: string;
  start_date: string;
  end_date: string;
  status: "active" | "conflict";
  external_ref: string | null;
  source_channel: string;
  booking_status: string;
  stay_status: string;
  guests: number | null;
  is_demo: boolean;
  /** null khi người xem không có quyền booking.view_guest_contact — không truy vấn tên. */
  guest_name: string | null;
}

export interface CalendarBlock {
  id: string;
  unit_id: string;
  unit_code: string;
  start_date: string;
  end_date: string;
  reason: string;
  created_by_name: string | null;
  created_at: Date;
}

export type CellItem =
  | { type: "booking"; allocation: CalendarAllocation; startsHere: boolean; endsAfter: boolean }
  | { type: "block"; block: CalendarBlock; startsHere: boolean }
  | { type: "indirect"; byUnitCode: string; byUnitId: string; label: string; bookingId: string | null };

export interface CalendarProperty {
  id: string;
  code: string;
  name: string;
  is_demo: boolean;
  units: CalendarUnit[];
}

export async function calendarData(actor: Actor, params: CalendarParams) {
  const org = actor.orgId;
  const { start, days } = params;
  const end = addDays(start, days);
  const nights = Array.from({ length: days }, (_, i) => addDays(start, i));
  const showGuest = can(actor, "booking.view_guest_contact");

  const allProperties = await query<{ id: string; code: string; name: string; is_demo: boolean }>(
    "SELECT id, code, name, is_demo FROM properties WHERE org_id = $1 AND status <> 'historical' ORDER BY code",
    [org],
  );
  const propertyIds = params.propertyId ? allProperties.filter((p) => p.id === params.propertyId).map((p) => p.id) : allProperties.map((p) => p.id);

  const units = await query<Omit<CalendarUnit, "readiness">>(
    `SELECT u.id, u.code, u.name, u.kind, u.capacity, u.active, u.is_demo, u.sort_order, u.property_id,
            coalesce(array_agg(ur.resource_id::text ORDER BY ur.resource_id) FILTER (WHERE ur.resource_id IS NOT NULL), '{}') AS resource_ids
       FROM units u LEFT JOIN unit_resources ur ON ur.unit_id = u.id AND ur.org_id = $1
      WHERE u.org_id = $1 AND u.property_id = ANY($2::uuid[])
      GROUP BY u.id
      ORDER BY u.sort_order, u.code`,
    [org, propertyIds],
  );
  const unitIds = units.map((u) => u.id);
  const readiness = await readinessForUnits(pool(), org, unitIds);

  // Lấy cả phân bổ kết thúc đúng ngày đầu cửa sổ để chế độ 1 ngày thấy khách trả phòng.
  const allocations = await query<CalendarAllocation>(
    `SELECT a.id AS allocation_id, a.booking_id, a.unit_id, a.start_date, a.end_date, a.status,
            b.external_ref, b.source_channel, b.booking_status, b.stay_status, coalesce(a.guests, b.total_guests) AS guests, b.is_demo,
            ${showGuest ? "g.full_name" : "NULL::text"} AS guest_name
       FROM booking_allocations a
       JOIN bookings b ON b.id = a.booking_id AND b.org_id = $1 AND b.booking_status <> 'cancelled'
       LEFT JOIN guests g ON g.id = b.guest_id AND g.org_id = $1
      WHERE a.org_id = $1 AND a.status IN ('active','conflict') AND a.unit_id = ANY($2::uuid[])
        AND a.start_date < $4 AND a.end_date >= $3
      ORDER BY a.start_date, a.unit_id`,
    [org, unitIds, start, end],
  );
  const blocks = await query<CalendarBlock>(
    `SELECT ib.id, ib.unit_id, u.code AS unit_code, ib.start_date, ib.end_date, ib.reason, us.full_name AS created_by_name, ib.created_at
       FROM inventory_blocks ib JOIN units u ON u.id = ib.unit_id LEFT JOIN users us ON us.id = ib.created_by
      WHERE ib.org_id = $1 AND ib.active AND ib.unit_id = ANY($2::uuid[]) AND ib.start_date < $4 AND ib.end_date > $3
      ORDER BY ib.start_date`,
    [org, unitIds, start, end],
  );

  const unitById = new Map(units.map((u) => [u.id, u]));
  const cells = new Map<string, CellItem[]>(); // key `${unitId}|${night}`
  const push = (unitId: string, night: string, item: CellItem) => {
    const key = `${unitId}|${night}`;
    const list = cells.get(key);
    if (list) list.push(item);
    else cells.set(key, [item]);
  };

  // Sản phẩm dùng chung ít nhất một tài nguyên (cùng tổ chức, đã lọc theo nhà ở trên).
  const sharing = new Map<string, CalendarUnit[]>();
  for (const u of units) {
    const set = new Set(u.resource_ids);
    sharing.set(
      u.id,
      units.filter((v) => v.id !== u.id && v.resource_ids.some((r) => set.has(r))).map((v) => ({ ...v, readiness: "unknown" as const })),
    );
  }

  for (const night of nights) {
    for (const a of allocations) {
      if (!(a.start_date <= night && night < a.end_date)) continue;
      push(a.unit_id, night, { type: "booking", allocation: a, startsHere: a.start_date === night || night === start, endsAfter: a.end_date > end });
      if (a.status !== "active") continue;
      const owner = unitById.get(a.unit_id);
      for (const other of sharing.get(a.unit_id) ?? []) {
        push(other.id, night, { type: "indirect", byUnitId: a.unit_id, byUnitCode: owner?.code ?? "?", label: `booking ${a.external_ref ?? "(không mã)"}`, bookingId: a.booking_id });
      }
    }
    for (const b of blocks) {
      if (!(b.start_date <= night && night < b.end_date)) continue;
      push(b.unit_id, night, { type: "block", block: b, startsHere: b.start_date === night || night === start });
      for (const other of sharing.get(b.unit_id) ?? []) {
        push(other.id, night, { type: "indirect", byUnitId: b.unit_id, byUnitCode: b.unit_code, label: `chặn tồn: ${b.reason}`, bookingId: null });
      }
    }
  }

  const properties: CalendarProperty[] = allProperties
    .filter((p) => propertyIds.includes(p.id))
    .map((p) => ({
      ...p,
      units: units.filter((u) => u.property_id === p.id).map((u) => ({ ...u, readiness: readiness.get(u.id) ?? "unknown" })),
    }));

  // Múi giờ ghi theo giữa trưa ngày đầu và ngày cuối — cửa sổ vắt qua lần đổi giờ thì ghi cả hai.
  const tzStart = tzAbbrev(localToUtc(start, "12:00", actor.timezone), actor.timezone);
  const tzEnd = tzAbbrev(localToUtc(nights[nights.length - 1], "12:00", actor.timezone), actor.timezone);

  return {
    start,
    end,
    days,
    nights,
    today: todayOps(actor.timezone),
    timezoneLabel: tzStart === tzEnd ? tzStart : `${tzStart} → ${tzEnd}`,
    allProperties,
    properties,
    allocations,
    blocks,
    cells: Object.fromEntries(cells),
    conflictCount: new Set(allocations.filter((a) => a.status === "conflict").map((a) => a.allocation_id)).size,
    showGuest,
  };
}

export type CalendarData = Awaited<ReturnType<typeof calendarData>>;

/** Danh sách chặn tồn đang hiệu lực (cho API). */
export async function listActiveBlocks(actor: Actor, opts: { from?: string | null; unitId?: string | null }) {
  const from = opts.from && isValidDate(opts.from) ? opts.from : todayOps(actor.timezone);
  return query<CalendarBlock>(
    `SELECT ib.id, ib.unit_id, u.code AS unit_code, ib.start_date, ib.end_date, ib.reason, us.full_name AS created_by_name, ib.created_at
       FROM inventory_blocks ib JOIN units u ON u.id = ib.unit_id LEFT JOIN users us ON us.id = ib.created_by
      WHERE ib.org_id = $1 AND ib.active AND ib.end_date > $2 AND ($3::uuid IS NULL OR ib.unit_id = $3::uuid)
      ORDER BY ib.start_date, u.code`,
    [actor.orgId, from, opts.unitId && UUID_RE.test(opts.unitId) ? opts.unitId : null],
  );
}

/** Sản phẩm để chọn khi tạo chặn tồn. */
export async function unitOptions(actor: Actor) {
  return query<{ id: string; code: string; name: string; kind: string; property_code: string; active: boolean }>(
    `SELECT u.id, u.code, u.name, u.kind, p.code AS property_code, u.active
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.org_id = $1 AND p.status <> 'historical'
      ORDER BY p.code, u.sort_order, u.code`,
    [actor.orgId],
  );
}
