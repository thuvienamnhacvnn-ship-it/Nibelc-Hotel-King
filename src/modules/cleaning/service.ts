import type pg from "pg";
import { type Queryable, query, withTx } from "@/lib/db";
import { AppError, conflict, forbidden, invalid, notFound } from "@/lib/errors";
import { localDateOf, now } from "@/lib/time";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";
import { type Actor, can } from "@/modules/auth/actor";
import { emitTaskChanged, logTaskEvent } from "./planner";
import { setReadinessForUnit } from "./readiness";

export const TASK_STATUS_LABELS: Record<string, string> = {
  pending_assignment: "Chờ phân công",
  assigned: "Đã giao",
  accepted: "Đã nhận",
  in_progress: "Đang dọn",
  awaiting_inspection: "Chờ kiểm",
  needs_reclean: "Cần dọn lại",
  passed: "Đạt",
  cancelled: "Đã hủy",
};

export const TASK_KIND_LABELS: Record<string, string> = {
  turnover: "Quay vòng trong ngày",
  departure: "Dọn sau khách đi",
  stayover: "Dọn giữa kỳ",
  shared_area: "Khu vực chung",
  reclean: "Dọn lại",
  manual: "Việc thêm",
};

interface TaskLock {
  id: string;
  org_id: string;
  unit_id: string;
  property_id: string;
  status: string;
  kind: string;
  assigned_to: string | null;
  version: number;
  change_ack_required: boolean;
  pending_change: Record<string, unknown> | null;
  departing_booking_id: string | null;
  service_date: string;
}

async function lockTask(tx: Queryable, actor: Actor, taskId: string): Promise<TaskLock> {
  const { rows } = await tx.query<TaskLock>(
    `SELECT id, org_id, unit_id, property_id, status, kind, assigned_to, version, change_ack_required, pending_change, departing_booking_id, service_date
       FROM cleaning_tasks WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [taskId, actor.orgId],
  );
  const task = rows[0];
  if (!task) throw notFound("việc dọn");
  // Cleaner chỉ được đụng vào việc của mình — trả 404 để không lộ việc của người khác.
  if (!can(actor, "cleaning.view_all") && !can(actor, "cleaning.manage") && task.assigned_to !== actor.userId) throw notFound("việc dọn");
  return task;
}

function assertVersion(task: TaskLock, expected: number | undefined) {
  if (expected != null && task.version !== expected) {
    throw conflict("stale_version", "Việc này vừa được cập nhật. Tải lại để xem thông tin mới nhất.", { currentVersion: task.version });
  }
}

/** Thay đổi từ booking chưa được xác nhận thì không làm tiếp bất kỳ bước nào của việc. */
function assertNoPendingChange(task: TaskLock) {
  if (task.change_ack_required) {
    throw conflict("change_ack_required", "Việc có thay đổi từ booking chưa được xác nhận (có thể không cần dọn nữa). Xác nhận thay đổi trước.");
  }
}

function assertOwner(actor: Actor, task: TaskLock) {
  if (!(can(actor, "cleaning.own") && task.assigned_to === actor.userId) && !can(actor, "cleaning.manage")) {
    throw forbidden("Chỉ cleaner được giao hoặc điều phối mới thao tác được việc này.");
  }
}

async function move(tx: pg.PoolClient, actor: Actor, task: TaskLock, to: string, eventType: string, sets: Record<string, unknown>, detail: Record<string, unknown> = {}) {
  const cols = Object.keys(sets);
  const params: unknown[] = [task.id, to, ...Object.values(sets)];
  const extra = cols.map((c, i) => `, ${c} = $${i + 3}`).join("");
  await tx.query(`UPDATE cleaning_tasks SET status = $2${extra}, version = version + 1, updated_at = now() WHERE id = $1`, params);
  await logTaskEvent(tx, actor.orgId, task.id, eventType, task.status, to, detail, { type: actor.kind, id: actor.userId });
  await emitTaskChanged(tx, actor.orgId, task.id, task.version + 1, eventType);
  await writeAudit(tx, auditActorOf(actor), `cleaning.${eventType}`, "cleaning_task", task.id, detail);
  return { id: task.id, status: to, version: task.version + 1 };
}

// ───────────────────────── Điều phối ─────────────────────────

export async function assignTask(actor: Actor, taskId: string, input: { userId: string; expectedVersion?: number }) {
  if (!can(actor, "cleaning.manage")) throw forbidden();
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertVersion(task, input.expectedVersion);
    if (!["pending_assignment", "assigned", "needs_reclean", "accepted"].includes(task.status)) {
      throw conflict("invalid_transition", "Chỉ giao được việc chưa bắt đầu.");
    }
    const cleaner = await tx.query<{ id: string; full_name: string }>(
      "SELECT u.id, u.full_name FROM users u JOIN cleaner_profiles cp ON cp.user_id = u.id AND cp.active WHERE u.id = $1 AND u.org_id = $2 AND u.active AND u.role = 'cleaner'",
      [input.userId, actor.orgId],
    );
    if (!cleaner.rows[0]) throw invalid("Người được giao không phải cleaner đang hoạt động.");
    return move(tx, actor, task, "assigned", task.assigned_to && task.assigned_to !== input.userId ? "reassigned" : "assigned", { assigned_to: input.userId, assigned_at: now(), accepted_at: null }, {
      from: task.assigned_to,
      to: input.userId,
      toName: cleaner.rows[0].full_name,
    });
  });
}

export async function unassignTask(actor: Actor, taskId: string, reason: string) {
  if (!can(actor, "cleaning.manage")) throw forbidden();
  if (!reason?.trim()) throw invalid("Cần lý do bỏ giao.");
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    if (!["assigned", "accepted"].includes(task.status)) throw conflict("invalid_transition", "Chỉ bỏ giao việc chưa bắt đầu.");
    return move(tx, actor, task, "pending_assignment", "unassigned", { assigned_to: null, assigned_at: null, accepted_at: null }, { from: task.assigned_to, reason });
  });
}

export async function cancelTask(actor: Actor, taskId: string, reason: string) {
  if (!can(actor, "cleaning.manage")) throw forbidden();
  if (!reason?.trim()) throw invalid("Cần lý do hủy việc.");
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    if (["passed", "cancelled"].includes(task.status)) throw conflict("invalid_transition", "Việc đã đóng.");
    if (["in_progress", "awaiting_inspection"].includes(task.status)) {
      // Phòng đã có người vào dọn nhưng chưa được kiểm: trả về "chưa dọn", không để kẹt ở "đang dọn".
      await setReadinessForUnit(tx, actor.orgId, task.unit_id, "vacated_dirty", { taskId: task.id, userId: actor.userId, note: `Hủy việc dọn: ${reason}` });
    }
    return move(tx, actor, task, "cancelled", "cancelled", { change_ack_required: false, pending_change: null }, { reason });
  });
}

/** Điều phối xác nhận khách đã rời phòng (khi không có dữ liệu check-out từ kênh). */
export async function confirmVacated(actor: Actor, taskId: string, note: string) {
  // Chỉ điều phối Budapest. Người khác ghi nhận trả phòng qua trạng thái lưu trú của booking.
  if (!can(actor, "cleaning.manage")) throw forbidden();
  if (!note?.trim()) throw invalid("Ghi rõ căn cứ xác nhận khách đã rời phòng (ví dụ: khách nhắn đã trả chìa).");
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    if (!["pending_assignment", "assigned", "accepted"].includes(task.status)) {
      throw conflict("invalid_transition", "Chỉ xác nhận khách rời cho việc chưa bắt đầu dọn.");
    }
    const tz = (await tx.query<{ timezone: string }>("SELECT timezone FROM properties WHERE id = $1", [task.property_id])).rows[0]?.timezone;
    if (task.service_date > localDateOf(now(), tz)) {
      throw conflict("service_date_in_future", "Chưa tới ngày trả phòng của việc này — không xác nhận khách rời trước.");
    }
    await setReadinessForUnit(tx, actor.orgId, task.unit_id, "vacated_dirty", { taskId: task.id, userId: actor.userId, note });
    await logTaskEvent(tx, actor.orgId, task.id, "vacancy_confirmed", task.status, task.status, { note }, { type: actor.kind, id: actor.userId });
    await writeAudit(tx, auditActorOf(actor), "cleaning.vacancy_confirmed", "cleaning_task", task.id, { note });
    return { ok: true };
  });
}

// ───────────────────────── Cleaner ─────────────────────────

export async function acceptTask(actor: Actor, taskId: string, expectedVersion?: number) {
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertVersion(task, expectedVersion);
    if (task.assigned_to !== actor.userId) throw forbidden("Việc này không giao cho bạn.");
    if (!["assigned", "needs_reclean"].includes(task.status)) throw conflict("invalid_transition", "Việc không ở trạng thái chờ nhận.");
    return move(tx, actor, task, "accepted", "accepted", { accepted_at: now() });
  });
}

export async function declineTask(actor: Actor, taskId: string, reason: string, expectedVersion?: number) {
  if (!reason?.trim()) throw invalid("Cần lý do từ chối để điều phối sắp xếp lại.");
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertVersion(task, expectedVersion);
    if (task.assigned_to !== actor.userId) throw forbidden("Việc này không giao cho bạn.");
    if (!["assigned", "accepted", "needs_reclean"].includes(task.status)) throw conflict("invalid_transition", "Không từ chối được việc đang làm hoặc đã xong.");
    const result = await move(tx, actor, task, "pending_assignment", "declined", { assigned_to: null, assigned_at: null, accepted_at: null }, { reason, by: actor.userId });
    await tx.query(
      `INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, payload, dedupe_key) VALUES ($1,'alert.task_declined','cleaning_task',$2,$3,$4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [actor.orgId, task.id, JSON.stringify({ reason }), `task:${task.id}:declined:v${task.version + 1}`],
    );
    return result;
  });
}

/** Chỉ bắt đầu khi đã xác nhận khách rời phòng — không dựa riêng vào giờ checkout dự kiến. */
export async function startTask(actor: Actor, taskId: string, expectedVersion?: number) {
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertVersion(task, expectedVersion);
    assertOwner(actor, task);
    if (task.status !== "accepted") throw conflict("invalid_transition", "Cần nhận việc trước khi bắt đầu.");
    if (task.change_ack_required) throw conflict("change_ack_required", "Việc có thay đổi chưa xác nhận. Xem và xác nhận thay đổi trước khi bắt đầu.");
    const vacancy = await vacancyStatus(tx, actor.orgId, task);
    if (!vacancy.ok) throw conflict("guest_not_confirmed_out", vacancy.message);
    await setReadinessForUnit(tx, actor.orgId, task.unit_id, "cleaning", { taskId: task.id, userId: actor.userId });
    return move(tx, actor, task, "in_progress", "started", { started_at: now() });
  });
}

export async function vacancyStatus(q: Queryable, orgId: string, task: Pick<TaskLock, "unit_id" | "kind" | "departing_booking_id">) {
  if (task.kind === "shared_area" || task.kind === "manual") return { ok: true, message: "" };
  if (task.departing_booking_id) {
    const { rows } = await q.query<{ stay_status: string; booking_status: string }>("SELECT stay_status, booking_status FROM bookings WHERE id = $1 AND org_id = $2", [
      task.departing_booking_id,
      orgId,
    ]);
    const b = rows[0];
    if (b && (["checked_out", "no_show"].includes(b.stay_status) || b.booking_status === "cancelled")) return { ok: true, message: "" };
  }
  const { rows } = await q.query<{ statuses: string[] }>(
    `SELECT array_agg(coalesce(rr.status, 'unknown')) AS statuses FROM unit_resources ur
       LEFT JOIN resource_readiness rr ON rr.resource_id = ur.resource_id WHERE ur.unit_id = $1`,
    [task.unit_id],
  );
  const statuses = rows[0]?.statuses ?? [];
  if (statuses.length && statuses.every((s) => ["vacated_dirty", "cleaning", "inspection_pending"].includes(s))) return { ok: true, message: "" };
  return { ok: false, message: "Chưa có xác nhận khách đã rời phòng. Liên hệ điều phối — không vào phòng chỉ dựa vào giờ trả phòng dự kiến." };
}

export async function toggleChecklistItem(actor: Actor, taskId: string, itemId: string, input: { checked: boolean; note?: string | null }) {
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertOwner(actor, task);
    if (task.status !== "in_progress") throw conflict("invalid_transition", "Chỉ đánh dấu checklist khi đang dọn.");
    assertNoPendingChange(task);
    const { rows } = await tx.query(
      `UPDATE task_checklist_items SET checked = $3, checked_by = CASE WHEN $3 THEN $4::uuid END, checked_at = CASE WHEN $3 THEN now() END, note = $5
        WHERE id = $1 AND task_id = $2 RETURNING id`,
      [itemId, taskId, input.checked, actor.userId, input.note ?? null],
    );
    if (!rows[0]) throw notFound("mục checklist");
    return { ok: true };
  });
}

export async function finishTask(actor: Actor, taskId: string, input: { expectedVersion?: number; note?: string | null } = {}) {
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertVersion(task, input.expectedVersion);
    assertOwner(actor, task);
    if (task.status !== "in_progress") throw conflict("invalid_transition", "Việc chưa ở trạng thái đang dọn.");
    assertNoPendingChange(task);
    const missing = await tx.query<{ label: string }>("SELECT label FROM task_checklist_items WHERE task_id = $1 AND NOT checked ORDER BY sort_order", [taskId]);
    if (missing.rows.length) {
      throw new AppError("checklist_incomplete", `Còn ${missing.rows.length} mục checklist chưa xong.`, 422, { missing: missing.rows.map((r) => r.label) });
    }
    // Mục checklist cần ảnh phải có ít nhất một ảnh còn hiệu lực — kiểm trong cùng giao dịch (không để khe hở xoá ảnh lúc bấm).
    const noPhoto = await tx.query<{ label: string }>(
      `SELECT i.label FROM task_checklist_items i
        WHERE i.task_id = $1 AND i.requires_photo
          AND NOT EXISTS (SELECT 1 FROM task_photos p WHERE p.task_id = i.task_id AND p.checklist_item_id = i.id AND p.status = 'active')
        ORDER BY i.sort_order`,
      [taskId],
    );
    if (noPhoto.rows.length) {
      throw new AppError("photo_evidence_missing", `Còn ${noPhoto.rows.length} mục cần ảnh bằng chứng chưa có ảnh.`, 422, { missing: noPhoto.rows.map((r) => r.label) });
    }
    await setReadinessForUnit(tx, actor.orgId, task.unit_id, "inspection_pending", { taskId: task.id, userId: actor.userId });
    return move(tx, actor, task, "awaiting_inspection", "finished", { finished_at: now(), note: input.note ?? null });
  });
}

export async function acknowledgeChange(actor: Actor, taskId: string, expectedVersion?: number) {
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertVersion(task, expectedVersion);
    assertOwner(actor, task);
    if (!task.change_ack_required || !task.pending_change) throw conflict("nothing_to_ack", "Không có thay đổi cần xác nhận.");
    const change = task.pending_change as { cancel?: boolean; kind?: string; service_date?: string; due_at?: string; earliest_start_at?: string; arriving_booking_id?: string | null };
    if (change.cancel) {
      return move(tx, actor, task, "cancelled", "change_acknowledged", { change_ack_required: false, pending_change: null }, { change });
    }
    return move(
      tx,
      actor,
      task,
      task.status,
      "change_acknowledged",
      {
        change_ack_required: false,
        pending_change: null,
        kind: change.kind,
        service_date: change.service_date,
        due_at: change.due_at,
        earliest_start_at: change.earliest_start_at,
        arriving_booking_id: change.arriving_booking_id ?? null,
      },
      { change },
    );
  });
}

// ───────────────────────── Kiểm phòng và sẵn sàng ─────────────────────────

export async function inspectTask(actor: Actor, taskId: string, input: { result: "pass" | "fail"; note?: string | null; expectedVersion?: number }) {
  if (!can(actor, "readiness.approve")) throw forbidden("Chỉ Budapest Team được duyệt phòng sẵn sàng.");
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertVersion(task, input.expectedVersion);
    if (task.status !== "awaiting_inspection") throw conflict("invalid_transition", "Việc chưa ở trạng thái chờ kiểm.");
    assertNoPendingChange(task);
    if (input.result === "fail") {
      if (!input.note?.trim()) throw invalid("Ghi rõ hạng mục cần dọn lại.");
      await setReadinessForUnit(tx, actor.orgId, task.unit_id, "vacated_dirty", { taskId: task.id, userId: actor.userId, note: input.note });
      // Dọn lại phải tích lại checklist từ đầu.
      await tx.query("UPDATE task_checklist_items SET checked = false, checked_by = NULL, checked_at = NULL WHERE task_id = $1", [task.id]);
      return move(tx, actor, task, "needs_reclean", "inspection_failed", { accepted_at: null }, { note: input.note });
    }
    const unchecked = await tx.query("SELECT 1 FROM task_checklist_items WHERE task_id = $1 AND NOT checked LIMIT 1", [taskId]);
    if (unchecked.rows.length) throw conflict("checklist_incomplete", "Checklist chưa đủ — không duyệt sẵn sàng.");
    const blocking = await tx.query<{ description: string }>(
      "SELECT description FROM task_incidents WHERE org_id = $1 AND unit_id = $2 AND severity = 'blocking' AND status <> 'resolved'",
      [actor.orgId, task.unit_id],
    );
    if (blocking.rows.length) {
      throw conflict("blocking_incident", "Còn sự cố chặn nhận khách chưa xử lý.", { incidents: blocking.rows.map((r) => r.description) });
    }
    await setReadinessForUnit(tx, actor.orgId, task.unit_id, "ready", { taskId: task.id, userId: actor.userId, note: input.note ?? null });
    return move(tx, actor, task, "passed", "inspection_passed", {}, { note: input.note ?? null, approvedBy: actor.userId });
  });
}

export async function reportIncident(
  actor: Actor,
  taskId: string,
  input: { kind: "maintenance" | "missing_supplies" | "damage" | "guest_still_inside" | "access" | "other"; severity: "low" | "normal" | "blocking"; description: string },
) {
  if (!input.description?.trim()) throw invalid("Mô tả sự cố.");
  return withTx(async (tx) => {
    const task = await lockTask(tx, actor, taskId);
    assertOwner(actor, task);
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO task_incidents (org_id, task_id, unit_id, kind, severity, description, reported_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [actor.orgId, task.id, task.unit_id, input.kind, input.severity, input.description.trim(), actor.userId],
    );
    if (input.severity === "blocking") {
      await setReadinessForUnit(tx, actor.orgId, task.unit_id, "out_of_service", { taskId: task.id, userId: actor.userId, note: input.description });
    }
    await logTaskEvent(tx, actor.orgId, task.id, "incident_reported", task.status, task.status, { incidentId: rows[0].id, ...input }, { type: actor.kind, id: actor.userId });
    await tx.query(
      `INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, payload, dedupe_key) VALUES ($1,'alert.incident','task_incident',$2,$3,$4)`,
      [actor.orgId, rows[0].id, JSON.stringify({ taskId: task.id, severity: input.severity, kind: input.kind }), `incident:${rows[0].id}`],
    );
    await writeAudit(tx, auditActorOf(actor), "cleaning.incident", "cleaning_task", task.id, input);
    return { id: rows[0].id };
  });
}

export async function resolveIncident(actor: Actor, incidentId: string, note: string) {
  if (!can(actor, "cleaning.manage")) throw forbidden();
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ unit_id: string; task_id: string | null; severity: string }>(
      "UPDATE task_incidents SET status = 'resolved', resolved_by = $2, resolved_at = now() WHERE id = $1 AND org_id = $3 AND status <> 'resolved' RETURNING unit_id, task_id, severity",
      [incidentId, actor.userId, actor.orgId],
    );
    if (!rows[0]) throw notFound("sự cố đang mở");
    await writeAudit(tx, auditActorOf(actor), "cleaning.incident_resolved", "task_incident", incidentId, { note });
    // Sự cố không chặn chưa từng đổi trạng thái phòng — đóng nó cũng không được đổi.
    if (rows[0].severity !== "blocking") return { ok: true };
    // Không tự chuyển phòng sang "sẵn sàng" — vẫn phải qua kiểm phòng.
    const still = await tx.query("SELECT 1 FROM task_incidents WHERE unit_id = $1 AND severity = 'blocking' AND status <> 'resolved' LIMIT 1", [rows[0].unit_id]);
    if (!still.rows.length) {
      await setReadinessForUnit(tx, actor.orgId, rows[0].unit_id, "vacated_dirty", { userId: actor.userId, note: `Đã xử lý sự cố: ${note}` });
    }
    return { ok: true };
  });
}

// ───────────────────────── Gợi ý phân công ─────────────────────────

export interface CleanerSuggestion {
  userId: string;
  fullName: string;
  score: number;
  reasons: string[];
  hasShift: boolean;
  tasksThatDay: number;
  maxTasks: number;
}

/** Gợi ý để Thảo chọn — giai đoạn đầu không tự giao. Không đủ người thì báo "chưa được phủ". */
export async function suggestCleaners(actor: Actor, taskId: string): Promise<CleanerSuggestion[]> {
  if (!can(actor, "cleaning.manage")) throw forbidden();
  const task = (await query<{ service_date: string; property_id: string; due_at: Date; estimated_minutes: number }>(
    "SELECT service_date, property_id, due_at, estimated_minutes FROM cleaning_tasks WHERE id = $1 AND org_id = $2",
    [taskId, actor.orgId],
  ))[0];
  if (!task) throw notFound("việc dọn");
  const rows = await query<{ user_id: string; full_name: string; max_tasks_per_day: number; preferred: boolean; has_shift: boolean; shift_end: string | null; tasks_that_day: number }>(
    `SELECT u.id AS user_id, u.full_name, cp.max_tasks_per_day,
            ($2::uuid = ANY(cp.preferred_property_ids)) AS preferred,
            EXISTS (SELECT 1 FROM cleaner_shifts s WHERE s.user_id = u.id AND s.work_date = $3) AS has_shift,
            (SELECT max(end_time)::text FROM cleaner_shifts s WHERE s.user_id = u.id AND s.work_date = $3) AS shift_end,
            (SELECT count(*)::int FROM cleaning_tasks t WHERE t.assigned_to = u.id AND t.service_date = $3 AND t.status NOT IN ('cancelled','passed')) AS tasks_that_day
       FROM users u JOIN cleaner_profiles cp ON cp.user_id = u.id AND cp.active
      WHERE u.org_id = $1 AND u.active AND u.role = 'cleaner'`,
    [actor.orgId, task.property_id, task.service_date],
  );
  return rows
    .map((r) => {
      const reasons: string[] = [];
      let score = 0;
      if (r.has_shift) {
        score += 50;
        reasons.push(`Có ca ngày ${task.service_date}${r.shift_end ? ` (đến ${r.shift_end.slice(0, 5)})` : ""}`);
      } else reasons.push("Không có ca trong ngày");
      if (r.tasks_that_day < r.max_tasks_per_day) {
        score += 20 * (1 - r.tasks_that_day / r.max_tasks_per_day);
        reasons.push(`Đã có ${r.tasks_that_day}/${r.max_tasks_per_day} việc`);
      } else reasons.push(`Đã đủ ${r.max_tasks_per_day} việc`);
      if (r.preferred) {
        score += 15;
        reasons.push("Quen nhà này");
      }
      return { userId: r.user_id, fullName: r.full_name, score: Math.round(score), reasons, hasShift: r.has_shift, tasksThatDay: r.tasks_that_day, maxTasks: r.max_tasks_per_day };
    })
    .sort((a, b) => b.score - a.score);
}

export function isOverdue(task: { due_at: Date | string; status: string }): boolean {
  return !["passed", "cancelled"].includes(task.status) && new Date(task.due_at).getTime() < now().getTime();
}

