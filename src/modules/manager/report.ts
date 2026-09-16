import { type Queryable, pool, query, queryOne } from "@/lib/db";
import { invalid } from "@/lib/errors";
import { formatDateVi, formatInstant, isValidDate, now } from "@/lib/time";
import { readinessForUnits } from "@/modules/cleaning/readiness";

/**
 * Báo cáo ngày của Agent Manager (đặc tả mục 5). MỌI con số lấy từ truy vấn có quy tắc; phần diễn giải
 * sinh bằng mẫu câu từ chính các con số đó (không LLM). Tách số booking, số phòng/sản phẩm và số lượt thay đổi.
 * Báo cáo đầu ngày không chứng minh khách đã đến hay đã rời — chỉ là lịch theo booking.
 */

export type ReportKind = "morning" | "evening";

export const REPORT_KIND_LABELS: Record<string, string> = { morning: "Đầu ngày", evening: "Cuối ngày", adhoc: "Lập tay" };

/** Connector hoạt động/thử nghiệm không đồng bộ thành công quá ngưỡng này thì coi là dữ liệu cũ. */
export const STALE_SYNC_HOURS = 6;

export interface MovementCount {
  bookings: number;
  units: number;
}

export interface DailyReportData {
  version: 1;
  opsDate: string;
  kind: ReportKind;
  timezone: string;
  cutoffAt: string;
  windowFrom: string;
  movement: { arrivals: MovementCount; departures: MovementCount; stayovers: MovementCount; roomMoves: number };
  last24h: { newBookings: MovementCount; cancelledBookings: MovementCount; changeEvents: number };
  pendingChangeRequests: { total: number; byKind: Record<string, number> };
  cleaning: {
    total: number;
    byStatus: Record<string, number>;
    byPerson: { userId: string | null; name: string; byStatus: Record<string, number>; total: number }[];
    overdue: number;
    awaitingInspection: number;
    needsReclean: number;
    flaggedPhotos: number;
  };
  arrivalsNotReady: { units: number; bookings: number; items: { unitCode: string; readiness: string }[] };
  incidents: { open: number; blocking: number };
  conflicts: { inventoryOpen: number; calendarFindingsOpen: number };
  support: { ticketsOpen: Record<string, number>; ticketsOverdue: number; handoffsOpen: Record<string, number>; conversationsUnread: number };
  connectors: { id: string; label: string; channel: string; status: string; paused: boolean; lastSuccessAt: string | null; lastError: string | null; stale: boolean }[];
  decisions: { changeRequests: number; conflicts: number; qaPendingReview: number; templatesDraft: number; refundTickets: number };
  sourcesFailed: { section: string; error: string }[];
}

type Section<T> = { section: string; run: () => Promise<T>; empty: T };

async function safe<T>(failed: DailyReportData["sourcesFailed"], s: Section<T>): Promise<T> {
  try {
    return await s.run();
  } catch (error) {
    failed.push({ section: s.section, error: (error as Error).message.slice(0, 300) });
    return s.empty;
  }
}

const count = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, r.n]));

/** Tính số liệu (không ghi). `cutoff` mặc định là đồng hồ hiện tại. */
export async function computeDailyReport(orgId: string, kind: ReportKind, opsDate: string, opts: { cutoff?: Date; client?: Queryable } = {}): Promise<DailyReportData> {
  if (!isValidDate(opsDate)) throw invalid("Ngày vận hành không hợp lệ (YYYY-MM-DD).");
  if (kind !== "morning" && kind !== "evening") throw invalid("Loại báo cáo phải là đầu ngày hoặc cuối ngày.");
  const c = opts.client ?? pool();
  const cutoff = opts.cutoff ?? now();
  const from = new Date(cutoff.getTime() - 24 * 3600_000);
  const org = await queryOne<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId], c);
  if (!org) throw invalid("Không tìm thấy tổ chức.");
  const failed: DailyReportData["sourcesFailed"] = [];
  const zeroMove = { bookings: 0, units: 0 };

  // Nhận/trả/ở tiếp tính theo ngày ở của BOOKING; phân bổ đổi phòng giữa kỳ không tính là khách đến/đi.
  const movementRows = await safe(failed, {
    section: "movement",
    empty: [] as { kind: string; booking_id: string; unit_id: string; unit_code: string }[],
    run: () =>
      query<{ kind: string; booking_id: string; unit_id: string; unit_code: string }>(
        `SELECT CASE WHEN a.start_date = $2 AND b.check_in_date = $2 THEN 'arrival'
                     WHEN a.end_date = $2 AND b.check_out_date = $2 THEN 'departure'
                     WHEN a.start_date <= $2 AND a.end_date > $2 THEN 'stayover'
                     ELSE 'move_out' END AS kind,
                b.id AS booking_id, u.id AS unit_id, u.code AS unit_code
           FROM booking_allocations a
           JOIN bookings b ON b.id = a.booking_id AND b.org_id = a.org_id AND b.booking_status <> 'cancelled'
           JOIN units u ON u.id = a.unit_id
          WHERE a.org_id = $1 AND a.status = 'active' AND a.start_date <= $2 AND a.end_date >= $2`,
        [orgId, opsDate],
        c,
      ),
  });
  const moveCount = (k: string): MovementCount => {
    const rows = movementRows.filter((r) => r.kind === k);
    return { bookings: new Set(rows.map((r) => r.booking_id)).size, units: rows.length };
  };
  const arrivalsRows = movementRows.filter((r) => r.kind === "arrival");

  const last24h = await safe(failed, {
    section: "last24h",
    empty: { newBookings: zeroMove, cancelledBookings: zeroMove, changeEvents: 0 },
    run: async () => {
      const r = await queryOne<{ new_b: number; new_u: number; cancel_b: number; cancel_u: number; changes: number }>(
        `WITH w AS (SELECT booking_id, change_type FROM booking_changes WHERE org_id = $1 AND created_at > $2 AND created_at <= $3),
              nb AS (SELECT DISTINCT booking_id FROM w WHERE change_type IN ('created','channel_created','imported')),
              cb AS (SELECT DISTINCT w.booking_id FROM w JOIN bookings b ON b.id = w.booking_id AND b.org_id = $1 AND b.booking_status = 'cancelled'
                      WHERE w.change_type IN ('channel_cancelled','change_request:cancel'))
         SELECT (SELECT count(*)::int FROM nb) AS new_b,
                (SELECT count(*)::int FROM booking_allocations a WHERE a.org_id = $1 AND a.booking_id IN (SELECT booking_id FROM nb) AND a.status <> 'released') AS new_u,
                (SELECT count(*)::int FROM cb) AS cancel_b,
                (SELECT count(DISTINCT a.unit_id)::int FROM booking_allocations a WHERE a.org_id = $1 AND a.booking_id IN (SELECT booking_id FROM cb)) AS cancel_u,
                (SELECT count(*)::int FROM w WHERE change_type NOT IN ('created','channel_created','imported')) AS changes`,
        [orgId, from, cutoff],
        c,
      );
      return {
        newBookings: { bookings: r?.new_b ?? 0, units: r?.new_u ?? 0 },
        cancelledBookings: { bookings: r?.cancel_b ?? 0, units: r?.cancel_u ?? 0 },
        changeEvents: r?.changes ?? 0,
      };
    },
  });

  const pendingChangeRequests = await safe(failed, {
    section: "change_requests",
    empty: { total: 0, byKind: {} },
    run: async () => {
      const rows = await query<{ k: string; n: number }>("SELECT kind AS k, count(*)::int AS n FROM change_requests WHERE org_id = $1 AND status = 'pending' GROUP BY kind", [orgId], c);
      return { total: rows.reduce((s, r) => s + r.n, 0), byKind: count(rows) };
    },
  });

  const cleaning = await safe(failed, {
    section: "cleaning",
    empty: { total: 0, byStatus: {}, byPerson: [], overdue: 0, awaitingInspection: 0, needsReclean: 0, flaggedPhotos: 0 },
    run: async () => {
      const rows = await query<{ user_id: string | null; name: string | null; status: string; n: number }>(
        `SELECT t.assigned_to AS user_id, u.full_name AS name, t.status, count(*)::int AS n
           FROM cleaning_tasks t LEFT JOIN users u ON u.id = t.assigned_to AND u.org_id = t.org_id
          WHERE t.org_id = $1 AND t.service_date = $2 AND t.status <> 'cancelled'
          GROUP BY t.assigned_to, u.full_name, t.status`,
        [orgId, opsDate],
        c,
      );
      const byStatus: Record<string, number> = {};
      const people = new Map<string, DailyReportData["cleaning"]["byPerson"][number]>();
      for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
        const key = r.user_id ?? "";
        const p = people.get(key) ?? { userId: r.user_id, name: r.name ?? "Chưa phân công", byStatus: {}, total: 0 };
        p.byStatus[r.status] = r.n;
        p.total += r.n;
        people.set(key, p);
      }
      const agg = await queryOne<{ overdue: number; awaiting: number; reclean: number; photos: number }>(
        `SELECT (SELECT count(*)::int FROM cleaning_tasks WHERE org_id = $1 AND status NOT IN ('passed','cancelled') AND due_at < $2) AS overdue,
                (SELECT count(*)::int FROM cleaning_tasks WHERE org_id = $1 AND status = 'awaiting_inspection') AS awaiting,
                (SELECT count(*)::int FROM cleaning_tasks WHERE org_id = $1 AND status = 'needs_reclean') AS reclean,
                (SELECT count(*)::int FROM task_photos WHERE org_id = $1 AND status = 'active' AND cardinality(flags) > 0) AS photos`,
        [orgId, cutoff],
        c,
      );
      return {
        total: rows.reduce((s, r) => s + r.n, 0),
        byStatus,
        byPerson: [...people.values()].sort((a, b) => (a.userId ? 0 : 1) - (b.userId ? 0 : 1) || a.name.localeCompare(b.name)),
        overdue: agg?.overdue ?? 0,
        awaitingInspection: agg?.awaiting ?? 0,
        needsReclean: agg?.reclean ?? 0,
        flaggedPhotos: agg?.photos ?? 0,
      };
    },
  });

  const arrivalsNotReady = await safe(failed, {
    section: "readiness",
    empty: { units: 0, bookings: 0, items: [] },
    run: async () => {
      const readiness = await readinessForUnits(c, orgId, arrivalsRows.map((a) => a.unit_id));
      const notReady = arrivalsRows.filter((a) => readiness.get(a.unit_id) !== "ready");
      return {
        units: notReady.length,
        bookings: new Set(notReady.map((a) => a.booking_id)).size,
        items: notReady.map((a) => ({ unitCode: a.unit_code, readiness: readiness.get(a.unit_id) ?? "unknown" })),
      };
    },
  });

  const incidents = await safe(failed, {
    section: "incidents",
    empty: { open: 0, blocking: 0 },
    run: async () => {
      const r = await queryOne<{ open: number; blocking: number }>(
        "SELECT count(*)::int AS open, count(*) FILTER (WHERE severity = 'blocking')::int AS blocking FROM task_incidents WHERE org_id = $1 AND status <> 'resolved'",
        [orgId],
        c,
      );
      return { open: r?.open ?? 0, blocking: r?.blocking ?? 0 };
    },
  });

  const conflicts = await safe(failed, {
    section: "conflicts",
    empty: { inventoryOpen: 0, calendarFindingsOpen: 0 },
    run: async () => {
      const r = await queryOne<{ inv: number; cal: number }>(
        `SELECT (SELECT count(*)::int FROM inventory_conflicts WHERE org_id = $1 AND status = 'open') AS inv,
                (SELECT count(*)::int FROM calendar_sync_findings WHERE org_id = $1 AND status = 'open') AS cal`,
        [orgId],
        c,
      );
      return { inventoryOpen: r?.inv ?? 0, calendarFindingsOpen: r?.cal ?? 0 };
    },
  });

  const support = await safe(failed, {
    section: "support",
    empty: { ticketsOpen: {}, ticketsOverdue: 0, handoffsOpen: {}, conversationsUnread: 0 },
    run: async () => {
      const tickets = await query<{ k: string; n: number }>(
        "SELECT priority AS k, count(*)::int AS n FROM tickets WHERE org_id = $1 AND status NOT IN ('resolved','verified','closed') GROUP BY priority",
        [orgId],
        c,
      );
      const handoffs = await query<{ k: string; n: number }>(
        "SELECT status AS k, count(*)::int AS n FROM handoffs WHERE org_id = $1 AND status IN ('requested','escalated','callback') GROUP BY status",
        [orgId],
        c,
      );
      const r = await queryOne<{ overdue: number; unread: number }>(
        `SELECT (SELECT count(*)::int FROM tickets WHERE org_id = $1 AND status IN ('new','assigned') AND accept_due_at < $2) AS overdue,
                (SELECT count(*)::int FROM conversations WHERE org_id = $1 AND status = 'open' AND unread_count > 0) AS unread`,
        [orgId, cutoff],
        c,
      );
      return { ticketsOpen: count(tickets), ticketsOverdue: r?.overdue ?? 0, handoffsOpen: count(handoffs), conversationsUnread: r?.unread ?? 0 };
    },
  });

  const connectors = await safe(failed, {
    section: "connectors",
    empty: [] as DailyReportData["connectors"],
    run: async () => {
      const rows = await query<{ id: string; label: string; channel: string; status: string; paused: boolean; last_success_at: Date | null; last_error: string | null; created_at: Date }>(
        "SELECT id, label, channel, status, paused, last_success_at, last_error, created_at FROM connector_accounts WHERE org_id = $1 AND status <> 'not_configured' ORDER BY label",
        [orgId],
        c,
      );
      const staleBefore = cutoff.getTime() - STALE_SYNC_HOURS * 3600_000;
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        channel: r.channel,
        status: r.status,
        paused: r.paused,
        lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
        lastError: r.last_error,
        stale:
          r.status === "error" ||
          ((r.status === "active" || r.status === "testing") && r.channel !== "whatsapp" && (r.last_success_at ? new Date(r.last_success_at).getTime() : new Date(r.created_at).getTime()) < staleBefore),
      }));
    },
  });

  const decisionsExtra = await safe(failed, {
    section: "decisions",
    empty: { qa: 0, templates: 0, refunds: 0 },
    run: async () =>
      (await queryOne<{ qa: number; templates: number; refunds: number }>(
        `SELECT (SELECT count(*)::int FROM qa_entries WHERE org_id = $1 AND status = 'pending_review') AS qa,
                (SELECT count(*)::int FROM message_templates WHERE org_id = $1 AND status = 'draft') AS templates,
                (SELECT count(*)::int FROM tickets WHERE org_id = $1 AND category = 'payment_refund' AND status NOT IN ('resolved','verified','closed')) AS refunds`,
        [orgId],
        c,
      )) ?? { qa: 0, templates: 0, refunds: 0 },
  });

  return {
    version: 1,
    opsDate,
    kind,
    timezone: org.timezone,
    cutoffAt: cutoff.toISOString(),
    windowFrom: from.toISOString(),
    movement: {
      arrivals: moveCount("arrival"),
      departures: moveCount("departure"),
      stayovers: moveCount("stayover"),
      roomMoves: movementRows.filter((r) => r.kind === "move_out").length,
    },
    last24h,
    pendingChangeRequests,
    cleaning,
    arrivalsNotReady,
    incidents,
    conflicts,
    support,
    connectors,
    decisions: {
      changeRequests: pendingChangeRequests.total,
      conflicts: conflicts.inventoryOpen + conflicts.calendarFindingsOpen,
      qaPendingReview: decisionsExtra.qa,
      templatesDraft: decisionsExtra.templates,
      refundTickets: decisionsExtra.refunds,
    },
    sourcesFailed: failed,
  };
}

const TASK_STATUS_SHORT: Record<string, string> = {
  pending_assignment: "chưa giao",
  assigned: "đã giao",
  accepted: "đã nhận",
  in_progress: "đang làm",
  awaiting_inspection: "chờ kiểm",
  needs_reclean: "dọn lại",
  passed: "đạt",
};

const bu = (m: MovementCount) => `${m.bookings} booking / ${m.units} phòng`;

/** Diễn giải bằng mẫu câu — chỉ đọc lại số liệu, không suy đoán. */
export function narrateReport(d: DailyReportData): string {
  const lines: string[] = [];
  const when = formatInstant(d.cutoffAt, d.timezone);
  lines.push(`${REPORT_KIND_LABELS[d.kind]} ${formatDateVi(d.opsDate)} — số liệu chốt lúc ${when} (giờ ${d.timezone}).`);
  lines.push(
    `Theo lịch booking: nhận phòng ${bu(d.movement.arrivals)}, trả phòng ${bu(d.movement.departures)}, ở tiếp ${bu(d.movement.stayovers)}.` +
      (d.movement.roomMoves ? ` Có ${d.movement.roomMoves} phân bổ đổi phòng giữa kỳ (không tính là khách đi).` : ""),
  );
  if (d.kind === "morning") lines.push("Đây là lịch dự kiến: báo cáo đầu ngày không chứng minh khách đã đến hay đã rời.");
  lines.push(
    `24 giờ qua: ${d.last24h.newBookings.bookings} booking mới (${d.last24h.newBookings.units} phòng), ${d.last24h.cancelledBookings.bookings} booking hủy đã xác nhận, ${d.last24h.changeEvents} lượt thay đổi khác.`,
  );
  if (d.pendingChangeRequests.total) lines.push(`${d.pendingChangeRequests.total} yêu cầu đổi ngày/phòng/số khách đang chờ duyệt — booking hiện hành giữ nguyên tới khi duyệt.`);
  const statusText = Object.entries(d.cleaning.byStatus)
    .map(([k, n]) => `${n} ${TASK_STATUS_SHORT[k] ?? k}`)
    .join(", ");
  lines.push(d.cleaning.total ? `Việc dọn trong ngày: ${d.cleaning.total} (${statusText}).` : "Không có việc dọn trong ngày.");
  if (d.cleaning.overdue) lines.push(`CHÚ Ý: ${d.cleaning.overdue} việc dọn đã quá hạn tại thời điểm chốt.`);
  if (d.cleaning.awaitingInspection || d.cleaning.needsReclean || d.cleaning.flaggedPhotos)
    lines.push(`Kiểm phòng: ${d.cleaning.awaitingInspection} chờ kiểm, ${d.cleaning.needsReclean} phải dọn lại, ${d.cleaning.flaggedPhotos} ảnh bị gắn cờ.`);
  if (d.arrivalsNotReady.units) lines.push(`CHÚ Ý: ${d.arrivalsNotReady.units} phòng có khách đến trong ngày chưa được duyệt sẵn sàng (${d.arrivalsNotReady.items.map((i) => i.unitCode).join(", ")}).`);
  if (d.incidents.open) lines.push(`Sự cố mở: ${d.incidents.open}${d.incidents.blocking ? `, trong đó ${d.incidents.blocking} chặn việc` : ""}.`);
  if (d.decisions.conflicts) lines.push(`Xung đột mở: ${d.conflicts.inventoryOpen} xung đột tồn, ${d.conflicts.calendarFindingsOpen} lệch lịch kênh.`);
  const tickets = Object.values(d.support.ticketsOpen).reduce((s, n) => s + n, 0);
  const handoffs = Object.values(d.support.handoffsOpen).reduce((s, n) => s + n, 0);
  if (tickets || handoffs || d.support.conversationsUnread)
    lines.push(
      `Hỗ trợ khách: ${tickets} ticket mở${d.support.ticketsOverdue ? ` (${d.support.ticketsOverdue} quá hạn nhận)` : ""}, ${handoffs} yêu cầu chuyển người chưa xong, ${d.support.conversationsUnread} hội thoại chưa đọc.`,
    );
  const stale = d.connectors.filter((c) => c.stale);
  if (stale.length) lines.push(`Dữ liệu có thể cũ: ${stale.map((c) => c.label).join(", ")} lỗi hoặc không đồng bộ thành công quá ${STALE_SYNC_HOURS} giờ.`);
  const decisionsTotal = d.decisions.changeRequests + d.decisions.conflicts + d.decisions.qaPendingReview + d.decisions.templatesDraft + d.decisions.refundTickets;
  if (decisionsTotal)
    lines.push(
      `Cần quyết định: ${d.decisions.changeRequests} thay đổi booking, ${d.decisions.conflicts} xung đột, ${d.decisions.qaPendingReview} câu Q&A, ${d.decisions.templatesDraft} mẫu tin, ${d.decisions.refundTickets} yêu cầu hoàn tiền/thanh toán.`,
    );
  if (d.sourcesFailed.length) lines.push(`Nguồn lỗi khi lập báo cáo: ${d.sourcesFailed.map((s) => s.section).join(", ")} — các mục này đang hiện 0, không phải số thật.`);
  return lines.join("\n");
}

/** Bản xem trước tin WhatsApp (ngắn). Chưa gửi — gửi phải qua bộ gửi có công tắc, mẫu đã duyệt, hạn mức. */
export function reportWhatsAppPreview(d: DailyReportData): string {
  const tickets = Object.values(d.support.ticketsOpen).reduce((s, n) => s + n, 0);
  const lines = [
    `*${REPORT_KIND_LABELS[d.kind]} ${formatDateVi(d.opsDate)}* (chốt ${formatInstant(d.cutoffAt, d.timezone)})`,
    `Nhận: ${bu(d.movement.arrivals)}`,
    `Trả: ${bu(d.movement.departures)}`,
    `Ở tiếp: ${bu(d.movement.stayovers)}`,
    `Mới 24h: ${d.last24h.newBookings.bookings} · Hủy 24h: ${d.last24h.cancelledBookings.bookings} · Chờ duyệt đổi: ${d.pendingChangeRequests.total}`,
    `Dọn: ${d.cleaning.total} việc · quá hạn ${d.cleaning.overdue} · chờ kiểm ${d.cleaning.awaitingInspection}`,
    `Phòng chưa sẵn sàng có khách đến: ${d.arrivalsNotReady.units}`,
    `Sự cố mở: ${d.incidents.open} · Xung đột: ${d.decisions.conflicts} · Ticket mở: ${tickets}`,
  ];
  const stale = d.connectors.filter((c) => c.stale).length;
  if (stale) lines.push(`⚠ ${stale} kết nối lỗi/dữ liệu cũ`);
  if (d.sourcesFailed.length) lines.push(`⚠ Nguồn lỗi: ${d.sourcesFailed.map((s) => s.section).join(", ")}`);
  if (d.kind === "morning") lines.push("_Lịch dự kiến — không chứng minh khách đã đến/rời._");
  return lines.join("\n");
}

/** Lập và lưu báo cáo (bản nháp). Bản nháp cũ cùng ngày + loại chuyển thành `superseded`. */
export async function buildDailyReport(orgId: string, kind: ReportKind, opsDate: string, opts: { generatedBy?: string | null; cutoff?: Date } = {}) {
  const data = await computeDailyReport(orgId, kind, opsDate, { cutoff: opts.cutoff });
  const narrative = narrateReport(data);
  await query("UPDATE manager_reports SET status = 'superseded' WHERE org_id = $1 AND ops_date = $2 AND kind = $3 AND status = 'draft'", [orgId, opsDate, kind]);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO manager_reports (org_id, kind, ops_date, cutoff_at, data, narrative, status, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7) RETURNING id`,
    [orgId, kind, opsDate, data.cutoffAt, JSON.stringify(data), narrative, opts.generatedBy ?? null],
  );
  return { id: row!.id, data, narrative };
}

