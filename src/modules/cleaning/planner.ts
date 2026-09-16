import type { Queryable } from "@/lib/db";
import { addDays, hhmm, localToUtc, todayOps } from "@/lib/time";
import { emit } from "@/modules/outbox/outbox";

/**
 * Trợ lý 2 — lập việc dọn từ lõi booking.
 *
 * Mỗi phân bổ phòng kết thúc (khách rời phòng đó) sinh một việc dọn cho đúng sản phẩm, khoá bằng dedupe_key
 * `dep:<allocation_id>` nên chạy lại bao nhiêu lần cũng không tạo trùng.
 * Booking thay đổi chỉ động vào việc liên quan:
 *   - việc chưa nhận (chờ giao / đã giao): xếp lại trực tiếp, ghi lịch sử;
 *   - việc đã nhận / đang làm: KHÔNG tự đổi — ghi pending_change và bắt buộc cleaner/điều phối xác nhận;
 *   - việc đã xong / đã kiểm: không đụng.
 * Hạn dọn tính theo khách đến tiếp theo trên cùng tài nguyên; giờ bắt đầu sớm nhất chỉ là mốc —
 * cleaner chỉ được bắt đầu khi đã xác nhận khách rời phòng (xem service.startTask).
 */

const LOOKAHEAD_DAYS = 7;
const OPEN_EDITABLE = ["pending_assignment", "assigned"];
const OPEN_IN_HAND = ["accepted", "in_progress"];

interface CandidateRow {
  allocation_id: string;
  allocation_status: string;
  booking_id: string;
  booking_status: string;
  stay_status: string;
  booking_version: number;
  late_checkout_time: string | null;
  unit_id: string;
  unit_kind: string;
  unit_clean_minutes: number | null;
  resource_count: number;
  property_id: string;
  timezone: string;
  check_in_from: string;
  check_out_at: string;
  default_clean_minutes: number;
  start_date: string;
  end_date: string;
  is_demo: boolean;
}

interface Desired {
  kind: "turnover" | "departure";
  service_date: string;
  earliest_start_at: Date;
  due_at: Date;
  arriving_booking_id: string | null;
  estimated_minutes: number;
  priority: number;
}

interface TaskRow {
  id: string;
  status: string;
  kind: string;
  service_date: string;
  due_at: Date;
  earliest_start_at: Date | null;
  arriving_booking_id: string | null;
  departing_allocation_id: string | null;
  version: number;
}

export async function planCleaningForBooking(tx: Queryable, orgId: string, bookingId: string) {
  // 1. Phạm vi: mọi sản phẩm dùng chung tài nguyên với các phòng booking này từng giữ (kể cả phân bổ đã giải phóng).
  const scope = await tx.query<{ unit_ids: string[]; min_start: string | null; max_end: string | null }>(
    `WITH own AS (SELECT unit_id, start_date, end_date FROM booking_allocations WHERE booking_id = $1 AND org_id = $2),
          res AS (SELECT DISTINCT ur.resource_id FROM unit_resources ur JOIN own ON own.unit_id = ur.unit_id)
     SELECT (SELECT coalesce(array_agg(DISTINCT ur.unit_id), '{}') FROM unit_resources ur JOIN res ON res.resource_id = ur.resource_id) AS unit_ids,
            (SELECT min(start_date)::text FROM own) AS min_start,
            (SELECT max(end_date)::text FROM own) AS max_end`,
    [bookingId, orgId],
  );
  const { unit_ids: unitIds, min_start: minStart, max_end: maxEnd } = scope.rows[0];
  if (!minStart || !maxEnd || unitIds.length === 0) return { created: 0, updated: 0, flagged: 0, cancelled: 0 };
  return planCleaningForUnits(tx, orgId, unitIds, addDays(minStart, -(LOOKAHEAD_DAYS + 1)), addDays(maxEnd, 1));
}

/** Lập lại việc dọn cho các phân bổ kết thúc trong [fromDate, toDate] trên các sản phẩm cho trước. */
export async function planCleaningForUnits(tx: Queryable, orgId: string, unitIds: string[], fromDate: string, toDate: string) {
  const stats = { created: 0, updated: 0, flagged: 0, cancelled: 0 };
  const { rows: candidates } = await tx.query<CandidateRow>(
    `SELECT a.id AS allocation_id, a.status AS allocation_status, b.id AS booking_id, b.booking_status, b.stay_status,
            b.version AS booking_version, b.late_checkout_time::text, b.is_demo,
            u.id AS unit_id, u.kind AS unit_kind, u.clean_minutes AS unit_clean_minutes,
            (SELECT count(*)::int FROM unit_resources ur WHERE ur.unit_id = u.id) AS resource_count,
            p.id AS property_id, p.timezone, p.check_in_from::text, p.check_out_at::text, p.default_clean_minutes,
            a.start_date, a.end_date
       FROM booking_allocations a
       JOIN bookings b ON b.id = a.booking_id
       JOIN units u ON u.id = a.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE a.org_id = $1 AND a.unit_id = ANY($2::uuid[]) AND a.end_date BETWEEN $3::date AND $4::date`,
    [orgId, unitIds, fromDate, toDate],
  );

  for (const c of candidates) {
    const desired = await desiredTask(tx, orgId, c);
    const existing = await tx.query<TaskRow>(
      `SELECT id, status, kind, service_date, due_at, earliest_start_at, arriving_booking_id, departing_allocation_id, version
         FROM cleaning_tasks WHERE org_id = $1 AND dedupe_key = $2 FOR UPDATE`,
      [orgId, `dep:${c.allocation_id}`],
    );
    const task = existing.rows[0];

    if (!task) {
      if (!desired) continue;
      // Lượt trả phòng đã qua (nhập lịch sử, sửa booking cũ) không sinh việc dọn mới — nếu không sẽ đầy việc quá hạn giả.
      if (c.end_date < todayOps(c.timezone)) continue;
      await createTask(tx, orgId, c, desired);
      stats.created += 1;
      continue;
    }

    if (!desired) {
      // Không còn khách rời phòng này nữa (hủy / đổi ngày / đổi phòng).
      const stayStarted = c.stay_status === "checked_in" || c.stay_status === "checked_out";
      if (OPEN_EDITABLE.includes(task.status)) {
        if (stayStarted) continue; // Phòng đã có người dùng: vẫn phải dọn dù booking hủy.
        await transition(tx, orgId, task, "cancelled", "auto_cancelled", { reason: "Booking/phân bổ phòng không còn hiệu lực", bookingVersion: c.booking_version });
        stats.cancelled += 1;
      } else if (OPEN_IN_HAND.includes(task.status)) {
        await flagChange(tx, orgId, task, { cancel: true, reason: "Booking hủy hoặc đổi phòng khi việc đã nhận — cần xác nhận có tiếp tục dọn không" }, c.booking_version);
        stats.flagged += 1;
      }
      continue;
    }

    const changed =
      task.kind !== desired.kind ||
      task.service_date !== desired.service_date ||
      new Date(task.due_at).getTime() !== desired.due_at.getTime() ||
      (task.earliest_start_at ? new Date(task.earliest_start_at).getTime() : 0) !== desired.earliest_start_at.getTime() ||
      (task.arriving_booking_id ?? null) !== desired.arriving_booking_id;
    if (!changed) continue;

    if (OPEN_EDITABLE.includes(task.status) || task.status === "needs_reclean") {
      await tx.query(
        `UPDATE cleaning_tasks SET kind = $2, service_date = $3, due_at = $4, earliest_start_at = $5, arriving_booking_id = $6,
                priority = $7, booking_version_seen = $8, version = version + 1, updated_at = now() WHERE id = $1`,
        [task.id, desired.kind, desired.service_date, desired.due_at, desired.earliest_start_at, desired.arriving_booking_id, desired.priority, c.booking_version],
      );
      await logTaskEvent(tx, orgId, task.id, "rescheduled", task.status, task.status, {
        before: { kind: task.kind, service_date: task.service_date, due_at: task.due_at },
        after: { kind: desired.kind, service_date: desired.service_date, due_at: desired.due_at },
      });
      await emitTaskChanged(tx, orgId, task.id, task.version + 1, "rescheduled");
      stats.updated += 1;
    } else if (OPEN_IN_HAND.includes(task.status)) {
      await flagChange(
        tx,
        orgId,
        task,
        {
          kind: desired.kind,
          service_date: desired.service_date,
          due_at: desired.due_at.toISOString(),
          earliest_start_at: desired.earliest_start_at.toISOString(),
          arriving_booking_id: desired.arriving_booking_id,
          reason: "Booking thay đổi khi việc đã nhận/đang làm",
        },
        c.booking_version,
      );
      stats.flagged += 1;
    }
  }
  return stats;
}

async function desiredTask(tx: Queryable, orgId: string, c: CandidateRow): Promise<Desired | null> {
  if (c.allocation_status !== "active" || c.booking_status === "cancelled") return null;
  // Khách đến tiếp theo trên cùng tài nguyên, trong cửa sổ nhìn trước.
  const next = await tx.query<{ arrival: string; booking_id: string; same_booking: boolean; early_checkin_time: string | null }>(
    `SELECT lower(cl.stay)::text AS arrival, a2.booking_id, (a2.booking_id = $3) AS same_booking, b2.early_checkin_time::text
       FROM resource_claims cl
       JOIN booking_allocations a2 ON a2.id = cl.allocation_id
       JOIN bookings b2 ON b2.id = a2.booking_id
      WHERE cl.org_id = $1 AND cl.active
        AND cl.resource_id IN (SELECT resource_id FROM unit_resources WHERE unit_id = $2)
        AND lower(cl.stay) >= $4::date AND lower(cl.stay) <= $5::date
        AND cl.allocation_id <> $6
      ORDER BY lower(cl.stay), (a2.booking_id = $3) DESC
      LIMIT 1`,
    [orgId, c.unit_id, c.booking_id, c.end_date, addDays(c.end_date, LOOKAHEAD_DAYS), c.allocation_id],
  );
  const arrival = next.rows[0];
  // Cùng booking ở tiếp ngay trên cùng tài nguyên (ví dụ nối đoạn) thì không có lượt rời phòng thật.
  if (arrival && arrival.same_booking && arrival.arrival === c.end_date) return null;

  const tz = c.timezone;
  const checkoutTime = hhmm(c.late_checkout_time ?? c.check_out_at);
  const earliest = localToUtc(c.end_date, checkoutTime, tz);
  const baseMinutes = c.unit_clean_minutes ?? c.default_clean_minutes * Math.max(1, c.unit_kind === "whole" ? c.resource_count : 1);

  if (arrival && arrival.arrival === c.end_date) {
    return {
      kind: "turnover",
      service_date: c.end_date,
      earliest_start_at: earliest,
      due_at: localToUtc(c.end_date, hhmm(arrival.early_checkin_time ?? c.check_in_from), tz),
      arriving_booking_id: arrival.booking_id,
      estimated_minutes: baseMinutes,
      priority: 2,
    };
  }
  return {
    kind: "departure",
    service_date: c.end_date,
    earliest_start_at: earliest,
    due_at: arrival
      ? localToUtc(arrival.arrival, hhmm(arrival.early_checkin_time ?? c.check_in_from), tz)
      : localToUtc(addDays(c.end_date, 1), hhmm(c.check_in_from), tz),
    arriving_booking_id: arrival?.booking_id ?? null,
    estimated_minutes: baseMinutes,
    priority: 1,
  };
}

async function createTask(tx: Queryable, orgId: string, c: CandidateRow, d: Desired) {
  const template = await tx.query<{ id: string; items: { key: string; label: string; category?: string; requiresPhoto?: boolean }[] }>(
    `SELECT id, items FROM checklist_templates
      WHERE org_id = $1 AND active AND task_kind = 'turnover' AND (property_id = $2 OR property_id IS NULL)
      ORDER BY property_id IS NULL, version DESC LIMIT 1`,
    [orgId, c.property_id],
  );
  const tpl = template.rows[0];
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cleaning_tasks (org_id, property_id, unit_id, kind, status, service_date, earliest_start_at, due_at, estimated_minutes,
                                departing_allocation_id, departing_booking_id, arriving_booking_id, booking_version_seen, priority,
                                dedupe_key, checklist_template_id, is_demo, note)
     VALUES ($1,$2,$3,$4,'pending_assignment',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (org_id, dedupe_key) DO NOTHING RETURNING id`,
    [
      orgId,
      c.property_id,
      c.unit_id,
      d.kind,
      d.service_date,
      d.earliest_start_at,
      d.due_at,
      d.estimated_minutes,
      c.allocation_id,
      c.booking_id,
      d.arriving_booking_id,
      c.booking_version,
      d.priority,
      `dep:${c.allocation_id}`,
      tpl?.id ?? null,
      c.is_demo,
      tpl ? null : "Chưa có checklist cho nhà này — Budapest Team cần cung cấp.",
    ],
  );
  if (!rows[0]) return;
  const taskId = rows[0].id;
  if (tpl) {
    let order = 0;
    for (const item of tpl.items) {
      await tx.query(
        `INSERT INTO task_checklist_items (org_id, task_id, item_key, label, category, requires_photo, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, taskId, item.key, item.label, item.category ?? null, item.requiresPhoto ?? false, order++],
      );
    }
  }
  await logTaskEvent(tx, orgId, taskId, "created", null, "pending_assignment", { kind: d.kind, due_at: d.due_at, bookingVersion: c.booking_version });
  await emitTaskChanged(tx, orgId, taskId, 1, "created");
}

async function flagChange(tx: Queryable, orgId: string, task: TaskRow, change: Record<string, unknown>, bookingVersion: number) {
  await tx.query(
    `UPDATE cleaning_tasks SET pending_change = $2, change_ack_required = true, booking_version_seen = $3, version = version + 1, updated_at = now()
      WHERE id = $1`,
    [task.id, JSON.stringify(change), bookingVersion],
  );
  await logTaskEvent(tx, orgId, task.id, "change_pending_ack", task.status, task.status, change);
  await emitTaskChanged(tx, orgId, task.id, task.version + 1, "change_pending_ack");
}

async function transition(tx: Queryable, orgId: string, task: TaskRow, to: string, eventType: string, detail: Record<string, unknown>) {
  await tx.query("UPDATE cleaning_tasks SET status = $2, version = version + 1, updated_at = now() WHERE id = $1", [task.id, to]);
  await logTaskEvent(tx, orgId, task.id, eventType, task.status, to, detail);
  await emitTaskChanged(tx, orgId, task.id, task.version + 1, eventType);
}

export async function logTaskEvent(
  tx: Queryable,
  orgId: string,
  taskId: string,
  eventType: string,
  from: string | null,
  to: string | null,
  detail: Record<string, unknown>,
  actor: { type: string; id: string | null } = { type: "system", id: null },
) {
  await tx.query(
    "INSERT INTO cleaning_task_events (org_id, task_id, event_type, from_status, to_status, detail, actor_type, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [orgId, taskId, eventType, from, to, JSON.stringify(detail), actor.type, actor.id],
  );
}

export async function emitTaskChanged(tx: Queryable, orgId: string, taskId: string, version: number, change: string) {
  await emit(tx, {
    orgId,
    topic: "cleaning_task.changed",
    aggregateType: "cleaning_task",
    aggregateId: taskId,
    aggregateVersion: version,
    payload: { change },
    dedupeKey: `task:${taskId}:v${version}`,
  });
}
