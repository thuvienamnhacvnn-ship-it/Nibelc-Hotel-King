import { query, queryOne } from "@/lib/db";
import type { Actor } from "@/modules/auth/actor";
import { readinessForUnits } from "@/modules/cleaning/readiness";
import { pool } from "@/lib/db";

/**
 * Số liệu "Tổng quan hôm nay" — mọi con số lấy bằng truy vấn trên dữ liệu thật trong DB, không ước lượng.
 * Tách số booking và số đơn vị phòng để không đếm lẫn.
 */
export async function todayOverview(actor: Actor, date: string) {
  const org = actor.orgId;
  const movement = await query<{
    kind: "arrival" | "departure" | "stayover";
    booking_id: string;
    external_ref: string | null;
    source_channel: string;
    stay_status: string;
    eta_local: string | null;
    unit_id: string;
    unit_code: string;
    unit_name: string;
    property_code: string;
    guests: number | null;
    total_guests: number | null;
    guest_name: string | null;
    is_demo: boolean;
    early_checkin_time: string | null;
    late_checkout_time: string | null;
  }>(
    `SELECT CASE WHEN a.start_date = $2 THEN 'arrival' WHEN a.end_date = $2 THEN 'departure' ELSE 'stayover' END AS kind,
            b.id AS booking_id, b.external_ref, b.source_channel, b.stay_status, b.eta_local, b.total_guests, b.is_demo,
            b.early_checkin_time::text, b.late_checkout_time::text,
            u.id AS unit_id, u.code AS unit_code, u.name AS unit_name, p.code AS property_code, a.guests, g.full_name AS guest_name
       FROM booking_allocations a
       JOIN bookings b ON b.id = a.booking_id AND b.booking_status <> 'cancelled'
       JOIN units u ON u.id = a.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN guests g ON g.id = b.guest_id
      WHERE a.org_id = $1 AND a.status = 'active' AND a.start_date <= $2 AND a.end_date >= $2
        -- phân bổ nối tiếp của cùng booking (đổi phòng) không tính là trả/nhận của khách
      ORDER BY kind, u.code`,
    [org, date],
  );
  const arrivals = movement.filter((m) => m.kind === "arrival");
  const departures = movement.filter((m) => m.kind === "departure");
  const stayovers = movement.filter((m) => m.kind === "stayover");

  const readiness = await readinessForUnits(pool(), org, arrivals.map((a) => a.unit_id));
  const notReady = arrivals.filter((a) => readiness.get(a.unit_id) !== "ready").map((a) => ({ ...a, readiness: readiness.get(a.unit_id) ?? "unknown" }));

  const tasks = await queryOne<{ total: number; unassigned: number; overdue: number; awaiting_inspection: number; needs_ack: number }>(
    `SELECT count(*) FILTER (WHERE service_date = $2 AND status <> 'cancelled')::int AS total,
            count(*) FILTER (WHERE status = 'pending_assignment' AND service_date <= $2)::int AS unassigned,
            count(*) FILTER (WHERE status NOT IN ('passed','cancelled') AND due_at < now())::int AS overdue,
            count(*) FILTER (WHERE status = 'awaiting_inspection')::int AS awaiting_inspection,
            count(*) FILTER (WHERE change_ack_required AND status NOT IN ('passed','cancelled'))::int AS needs_ack
       FROM cleaning_tasks WHERE org_id = $1`,
    [org, date],
  );
  const overdueTasks = await query<{ id: string; unit_code: string; status: string; due_at: Date; assignee: string | null }>(
    `SELECT t.id, u.code AS unit_code, t.status, t.due_at, us.full_name AS assignee
       FROM cleaning_tasks t JOIN units u ON u.id = t.unit_id LEFT JOIN users us ON us.id = t.assigned_to
      WHERE t.org_id = $1 AND t.status NOT IN ('passed','cancelled') AND t.due_at < now()
      ORDER BY t.due_at LIMIT 10`,
    [org],
  );
  const pending = await queryOne<{ change_requests: number; conflicts: number; incidents: number }>(
    `SELECT (SELECT count(*)::int FROM change_requests WHERE org_id = $1 AND status = 'pending') AS change_requests,
            (SELECT count(*)::int FROM inventory_conflicts WHERE org_id = $1 AND status = 'open') AS conflicts,
            (SELECT count(*)::int FROM task_incidents WHERE org_id = $1 AND status <> 'resolved') AS incidents`,
    [org],
  );
  const connectors = await query<{ id: string; channel: string; label: string; status: string; last_success_at: Date | null; last_error: string | null; paused: boolean }>(
    "SELECT id, channel, label, status, last_success_at, last_error, paused FROM connector_accounts WHERE org_id = $1 ORDER BY status = 'not_configured', label",
    [org],
  );
  return {
    date,
    arrivals,
    departures,
    stayovers,
    notReady,
    counts: {
      arrivalBookings: new Set(arrivals.map((a) => a.booking_id)).size,
      arrivalUnits: arrivals.length,
      departureBookings: new Set(departures.map((a) => a.booking_id)).size,
      departureUnits: departures.length,
      stayoverBookings: new Set(stayovers.map((a) => a.booking_id)).size,
      stayoverUnits: stayovers.length,
    },
    tasks: tasks!,
    overdueTasks,
    pending: pending!,
    connectors,
  };
}
