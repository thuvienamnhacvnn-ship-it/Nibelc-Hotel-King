import { pool, query, queryOne } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import { hhmm, localToUtc, todayOps } from "@/lib/time";
import { type Actor, can } from "@/modules/auth/actor";
import { READINESS_LABELS, type ReadinessStatus, readinessForUnits } from "./readiness";
import { TASK_STATUS_LABELS, isOverdue, vacancyStatus } from "./service";

/**
 * Truy vấn đọc cho màn hình cleaning (điều phối, chi tiết, mobile cleaner).
 * Mọi truy vấn lọc org_id. Cleaner chỉ lấy việc assigned_to = chính mình và không bao giờ nhận tên/SĐT khách hay số tiền.
 */

export const OPEN_STATUSES = ["pending_assignment", "assigned", "accepted", "in_progress", "awaiting_inspection", "needs_reclean"];

export const INCIDENT_KIND_LABELS: Record<string, string> = {
  maintenance: "Hỏng hóc / bảo trì",
  missing_supplies: "Thiếu vật tư",
  damage: "Hư hại",
  guest_still_inside: "Khách còn trong phòng",
  access: "Không vào được phòng",
  other: "Khác",
};

export const INCIDENT_SEVERITY_LABELS: Record<string, string> = {
  low: "Nhẹ",
  normal: "Bình thường",
  blocking: "Chặn nhận khách",
};

export const TASK_EVENT_LABELS: Record<string, string> = {
  created: "Tạo việc",
  assigned: "Giao việc",
  reassigned: "Đổi người làm",
  unassigned: "Bỏ giao",
  declined: "Cleaner từ chối",
  accepted: "Cleaner nhận việc",
  started: "Bắt đầu dọn",
  finished: "Báo hoàn thành",
  cancelled: "Hủy việc",
  auto_cancelled: "Tự hủy theo booking",
  rescheduled: "Đổi hạn / loại việc",
  change_pending_ack: "Thay đổi chờ xác nhận",
  change_acknowledged: "Đã xác nhận thay đổi",
  vacancy_confirmed: "Xác nhận khách đã rời",
  inspection_passed: "Kiểm phòng: đạt",
  inspection_failed: "Kiểm phòng: cần dọn lại",
  incident_reported: "Báo sự cố",
};

const STATUS_SET = new Set(Object.keys(TASK_STATUS_LABELS));

export interface TaskListRow {
  id: string;
  kind: string;
  status: string;
  service_date: string;
  earliest_start_at: Date | null;
  due_at: Date;
  estimated_minutes: number;
  assigned_to: string | null;
  assignee_name: string | null;
  change_ack_required: boolean;
  pending_change: Record<string, unknown> | null;
  version: number;
  is_demo: boolean;
  note: string | null;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  property_id: string;
  property_code: string;
  property_name: string;
  property_address: string | null;
  check_in_from: string;
  departing_booking_id: string | null;
  departing_stay_status: string | null;
  departing_booking_status: string | null;
  departing_check_out_date: string | null;
  departing_late_checkout: string | null;
  arriving_booking_id: string | null;
  arriving_check_in_date: string | null;
  arriving_early_checkin: string | null;
  arriving_eta: string | null;
  arriving_guests: number | null;
  arriving_booking_status: string | null;
  open_incidents: number;
  blocking_incidents: number;
  checklist_total: number;
  checklist_done: number;
}

export interface TaskView extends TaskListRow {
  overdue: boolean;
  vacancy: { ok: boolean; message: string };
  /** Giờ khách đến tiếp theo (UTC) — giờ nhận sớm nếu có, không thì giờ nhận phòng của nhà. */
  next_arrival_at: Date | null;
  readiness: ReadinessStatus;
  readiness_label: string;
}

const TASK_SELECT = `
  SELECT t.id, t.kind, t.status, t.service_date, t.earliest_start_at, t.due_at, t.estimated_minutes, t.assigned_to, us.full_name AS assignee_name,
         t.change_ack_required, t.pending_change, t.version, (t.is_demo OR u.is_demo OR p.is_demo) AS is_demo, t.note,
         u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
         p.id AS property_id, p.code AS property_code, p.name AS property_name, p.address AS property_address, p.check_in_from::text,
         t.departing_booking_id, db.stay_status AS departing_stay_status, db.booking_status AS departing_booking_status,
         db.check_out_date AS departing_check_out_date, db.late_checkout_time::text AS departing_late_checkout,
         t.arriving_booking_id, coalesce(arr.start_date, ab.check_in_date) AS arriving_check_in_date,
         CASE WHEN coalesce(arr.start_date, ab.check_in_date) = ab.check_in_date THEN ab.early_checkin_time::text END AS arriving_early_checkin,
         ab.eta_local AS arriving_eta, ab.booking_status AS arriving_booking_status,
         coalesce(arr.guests, ab.total_guests) AS arriving_guests,
         (SELECT count(*)::int FROM task_incidents i WHERE i.org_id = t.org_id AND i.unit_id = t.unit_id AND i.status <> 'resolved') AS open_incidents,
         (SELECT count(*)::int FROM task_incidents i WHERE i.org_id = t.org_id AND i.unit_id = t.unit_id AND i.status <> 'resolved' AND i.severity = 'blocking') AS blocking_incidents,
         (SELECT count(*)::int FROM task_checklist_items c WHERE c.task_id = t.id) AS checklist_total,
         (SELECT count(*)::int FROM task_checklist_items c WHERE c.task_id = t.id AND c.checked) AS checklist_done
    FROM cleaning_tasks t
    JOIN units u ON u.id = t.unit_id
    JOIN properties p ON p.id = t.property_id
    LEFT JOIN users us ON us.id = t.assigned_to AND us.org_id = t.org_id
    LEFT JOIN bookings db ON db.id = t.departing_booking_id AND db.org_id = t.org_id
    LEFT JOIN bookings ab ON ab.id = t.arriving_booking_id AND ab.org_id = t.org_id
    -- Phân bổ đến tiếp của booking trên phòng dùng chung tài nguyên (đổi phòng giữa kỳ thì ngày đến khác ngày nhận phòng của booking)
    LEFT JOIN LATERAL (
      SELECT a.start_date, a.guests FROM booking_allocations a
       WHERE a.booking_id = ab.id AND a.status = 'active' AND a.start_date >= t.service_date
         AND EXISTS (SELECT 1 FROM unit_resources r1 JOIN unit_resources r2 ON r2.resource_id = r1.resource_id WHERE r1.unit_id = a.unit_id AND r2.unit_id = t.unit_id)
       ORDER BY a.start_date LIMIT 1
    ) arr ON true`;

async function decorate(orgId: string, rows: TaskListRow[]): Promise<TaskView[]> {
  const readiness = await readinessForUnits(pool(), orgId, [...new Set(rows.map((r) => r.unit_id))]);
  const out: TaskView[] = [];
  for (const r of rows) {
    const closed = r.status === "passed" || r.status === "cancelled";
    const vacancy = closed ? { ok: true, message: "" } : await vacancyStatus(pool(), orgId, { unit_id: r.unit_id, kind: r.kind, departing_booking_id: r.departing_booking_id });
    const arrivalTime = r.arriving_early_checkin ?? r.check_in_from;
    const readinessStatus = readiness.get(r.unit_id) ?? "unknown";
    out.push({
      ...r,
      overdue: isOverdue(r),
      vacancy,
      next_arrival_at: r.arriving_check_in_date && arrivalTime ? localToUtc(r.arriving_check_in_date, hhmm(arrivalTime)) : null,
      readiness: readinessStatus,
      readiness_label: READINESS_LABELS[readinessStatus],
    });
  }
  return out;
}

export interface DayBoardFilter {
  date: string;
  status?: string | null;
  propertyId?: string | null;
}

/** Việc của một ngày vận hành. Xem ngày hôm nay thì kéo theo việc ngày trước còn mở (quá hạn/chưa xong). */
export async function listTasksForDay(actor: Actor, filter: DayBoardFilter): Promise<TaskView[]> {
  if (!can(actor, "cleaning.view_all")) throw forbidden();
  const params: unknown[] = [actor.orgId, filter.date];
  const carryOver = filter.date === todayOps(actor.timezone);
  let where = carryOver
    ? `t.org_id = $1 AND (t.service_date = $2 OR (t.service_date < $2 AND t.status = ANY($3::text[])))`
    : "t.org_id = $1 AND t.service_date = $2";
  if (carryOver) params.push(OPEN_STATUSES);
  if (filter.status && STATUS_SET.has(filter.status)) {
    params.push(filter.status);
    where += ` AND t.status = $${params.length}`;
  }
  if (filter.propertyId && /^[0-9a-f-]{36}$/i.test(filter.propertyId)) {
    params.push(filter.propertyId);
    where += ` AND t.property_id = $${params.length}`;
  }
  const rows = await query<TaskListRow>(`${TASK_SELECT} WHERE ${where} ORDER BY t.status = 'cancelled', t.priority DESC, t.due_at, u.code`, params);
  return decorate(actor.orgId, rows);
}

export interface CleanerDay {
  user_id: string;
  full_name: string;
  max_tasks_per_day: number;
  shifts: string[];
  tasks_that_day: number;
  is_demo: boolean;
}

/** Cleaner đang hoạt động, ca làm và số việc (chưa đóng) trong ngày. */
export async function cleanersForDay(actor: Actor, date: string): Promise<CleanerDay[]> {
  if (!can(actor, "cleaning.view_all")) throw forbidden();
  return query<CleanerDay>(
    `SELECT u.id AS user_id, u.full_name, cp.max_tasks_per_day, u.is_demo,
            coalesce((SELECT array_agg(to_char(s.start_time, 'HH24:MI') || '–' || to_char(s.end_time, 'HH24:MI') ORDER BY s.start_time)
                        FROM cleaner_shifts s WHERE s.user_id = u.id AND s.org_id = u.org_id AND s.work_date = $2), '{}') AS shifts,
            (SELECT count(*)::int FROM cleaning_tasks t WHERE t.org_id = u.org_id AND t.assigned_to = u.id AND t.service_date = $2
                AND t.status NOT IN ('cancelled','passed')) AS tasks_that_day
       FROM users u JOIN cleaner_profiles cp ON cp.user_id = u.id AND cp.active
      WHERE u.org_id = $1 AND u.active AND u.role = 'cleaner'
      ORDER BY u.full_name`,
    [actor.orgId, date],
  );
}

export async function propertyOptions(actor: Actor) {
  return query<{ id: string; code: string; name: string }>("SELECT id, code, name FROM properties WHERE org_id = $1 AND status = 'active' ORDER BY code", [actor.orgId]);
}

/** Mọi việc chờ kiểm (không giới hạn ngày) — hàng đợi của Budapest Team. */
export async function awaitingInspection(actor: Actor): Promise<TaskView[]> {
  if (!can(actor, "cleaning.view_all")) throw forbidden();
  const rows = await query<TaskListRow>(`${TASK_SELECT} WHERE t.org_id = $1 AND t.status = 'awaiting_inspection' ORDER BY t.due_at`, [actor.orgId]);
  return decorate(actor.orgId, rows);
}

export interface IncidentRow {
  id: string;
  task_id: string | null;
  unit_id: string;
  unit_code: string;
  property_code: string;
  kind: string;
  severity: string;
  description: string;
  status: string;
  reported_by_name: string | null;
  resolved_by_name: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

const INCIDENT_SELECT = `
  SELECT i.id, i.task_id, i.unit_id, u.code AS unit_code, p.code AS property_code, i.kind, i.severity, i.description, i.status,
         rb.full_name AS reported_by_name, sb.full_name AS resolved_by_name, i.created_at, i.resolved_at
    FROM task_incidents i
    JOIN units u ON u.id = i.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN users rb ON rb.id = i.reported_by
    LEFT JOIN users sb ON sb.id = i.resolved_by`;

export async function openIncidents(actor: Actor): Promise<IncidentRow[]> {
  if (!can(actor, "cleaning.view_all")) throw forbidden();
  return query<IncidentRow>(`${INCIDENT_SELECT} WHERE i.org_id = $1 AND i.status <> 'resolved' ORDER BY i.severity = 'blocking' DESC, i.created_at`, [actor.orgId]);
}

// ───────────────────────── Chi tiết ─────────────────────────

export interface ChecklistItemRow {
  id: string;
  item_key: string;
  label: string;
  category: string | null;
  requires_photo: boolean;
  sort_order: number;
  checked: boolean;
  checked_at: Date | null;
  checked_by_name: string | null;
  note: string | null;
}

export interface TaskEventRow {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  detail: Record<string, unknown> | null;
  actor_type: string;
  actor_name: string | null;
  created_at: Date;
}

export interface BookingBrief {
  id: string;
  external_ref: string | null;
  source_channel: string;
  booking_status: string;
  stay_status: string;
  check_in_date: string;
  check_out_date: string;
  total_guests: number | null;
  eta_local: string | null;
  early_checkin_time: string | null;
  late_checkout_time: string | null;
  is_demo: boolean;
  /** Chỉ có khi người xem có booking.view_guest_contact. */
  guest_name?: string | null;
}

export interface TaskDetail {
  task: TaskView;
  checklist: ChecklistItemRow[];
  events: TaskEventRow[];
  incidents: IncidentRow[];
  departing: BookingBrief | null;
  arriving: BookingBrief | null;
  /** Tên người dùng trong lịch sử (id → tên), để hiện "đổi từ A sang B". */
  userNames: Record<string, string>;
}

async function bookingBrief(actor: Actor, id: string | null): Promise<BookingBrief | null> {
  if (!id) return null;
  const withGuest = can(actor, "booking.view_guest_contact");
  const row = await queryOne<BookingBrief & { guest_full_name: string | null }>(
    `SELECT b.id, b.external_ref, b.source_channel, b.booking_status, b.stay_status, b.check_in_date, b.check_out_date, b.total_guests,
            b.eta_local, b.early_checkin_time::text, b.late_checkout_time::text, b.is_demo,
            ${withGuest ? "g.full_name" : "NULL"} AS guest_full_name
       FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id AND g.org_id = b.org_id
      WHERE b.id = $1 AND b.org_id = $2`,
    [id, actor.orgId],
  );
  if (!row) return null;
  const { guest_full_name, ...rest } = row;
  // Cleaner không có quyền xem booking: chỉ giữ thông tin cần cho công việc.
  if (!can(actor, "booking.view")) {
    return { ...rest, external_ref: null, source_channel: "other" };
  }
  return withGuest ? { ...rest, guest_name: guest_full_name } : rest;
}

/**
 * Chi tiết một việc. Người không có cleaning.view_all chỉ mở được việc giao cho chính mình — việc người khác trả 404
 * (không lộ là việc có tồn tại).
 */
export async function getTaskDetail(actor: Actor, taskId: string): Promise<TaskDetail> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw notFound("việc dọn");
  const viewAll = can(actor, "cleaning.view_all");
  if (!viewAll && !can(actor, "cleaning.own")) throw forbidden();
  const params: unknown[] = [taskId, actor.orgId];
  let where = "t.id = $1 AND t.org_id = $2";
  if (!viewAll) {
    params.push(actor.userId);
    where += " AND t.assigned_to = $3";
  }
  const rows = await query<TaskListRow>(`${TASK_SELECT} WHERE ${where}`, params);
  if (!rows[0]) throw notFound("việc dọn");
  const [task] = await decorate(actor.orgId, rows);

  const [checklist, events, incidents, departing, arriving] = await Promise.all([
    query<ChecklistItemRow>(
      `SELECT c.id, c.item_key, c.label, c.category, c.requires_photo, c.sort_order, c.checked, c.checked_at, cu.full_name AS checked_by_name, c.note
         FROM task_checklist_items c LEFT JOIN users cu ON cu.id = c.checked_by
        WHERE c.task_id = $1 AND c.org_id = $2 ORDER BY c.sort_order, c.label`,
      [taskId, actor.orgId],
    ),
    viewAll
      ? query<TaskEventRow>(
          `SELECT e.id, e.event_type, e.from_status, e.to_status, e.detail, e.actor_type, eu.full_name AS actor_name, e.created_at
             FROM cleaning_task_events e LEFT JOIN users eu ON eu.id = e.actor_id
            WHERE e.task_id = $1 AND e.org_id = $2 ORDER BY e.created_at DESC, e.id`,
          [taskId, actor.orgId],
        )
      : Promise.resolve([] as TaskEventRow[]),
    query<IncidentRow>(`${INCIDENT_SELECT} WHERE i.org_id = $2 AND (i.task_id = $1 OR (i.unit_id = $3 AND i.status <> 'resolved')) ORDER BY i.status = 'resolved', i.created_at DESC`, [
      taskId,
      actor.orgId,
      task.unit_id,
    ]),
    bookingBrief(actor, task.departing_booking_id),
    bookingBrief(actor, task.arriving_booking_id),
  ]);

  const ids = new Set<string>();
  for (const e of events) {
    for (const key of ["from", "to", "by", "approvedBy"]) {
      const v = e.detail?.[key];
      if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) ids.add(v);
    }
  }
  const names = ids.size
    ? await query<{ id: string; full_name: string }>("SELECT id, full_name FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])", [actor.orgId, [...ids]])
    : [];
  return { task, checklist, events, incidents, departing, arriving, userNames: Object.fromEntries(names.map((n) => [n.id, n.full_name])) };
}

// ───────────────────────── Mobile cleaner ─────────────────────────

export interface MyTasks {
  today: TaskView[];
  reclean: TaskView[];
  upcoming: TaskView[];
  waiting: TaskView[];
}

/** Việc giao cho chính người đang đăng nhập: hôm nay (kể cả việc ngày trước còn mở), cần làm lại, sắp tới, đã gửi chờ kiểm. */
export async function myTasks(actor: Actor): Promise<MyTasks> {
  if (!actor.userId) throw forbidden();
  const today = todayOps(actor.timezone);
  const rows = await query<TaskListRow>(
    `${TASK_SELECT} WHERE t.org_id = $1 AND t.assigned_to = $2 AND t.status = ANY($4::text[])
       AND t.service_date <= ($3::date + 14) ORDER BY t.service_date, t.due_at, u.code`,
    [actor.orgId, actor.userId, today, OPEN_STATUSES],
  );
  const views = await decorate(actor.orgId, rows);
  return {
    reclean: views.filter((t) => t.status === "needs_reclean"),
    waiting: views.filter((t) => t.status === "awaiting_inspection"),
    today: views.filter((t) => t.service_date <= today && !["needs_reclean", "awaiting_inspection"].includes(t.status)),
    upcoming: views.filter((t) => t.service_date > today && !["needs_reclean", "awaiting_inspection"].includes(t.status)),
  };
}
