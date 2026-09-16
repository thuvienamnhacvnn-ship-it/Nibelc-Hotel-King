import { query, queryOne, withTx } from "@/lib/db";
import { formatDateVi, localDateOf, localTimeOf, now } from "@/lib/time";
import { isPaused } from "@/modules/automation/switches";
import { enqueueStaffNotification } from "@/modules/notifications/enqueue";
import { sendQueuedNotifications } from "@/modules/notifications/sender";
import type { PeriodicJob } from "@/worker/registry";
import { escalateOverdueHandoffs, escalateOverdueTickets, raiseSystemAlerts } from "./escalation";
import { REPORT_KIND_LABELS, type ReportKind, buildDailyReport, reportWhatsAppPreview } from "./report";

/**
 * Việc nền của Agent Manager (worker tự nạp file này — xem src/worker/handlers.ts).
 * Mọi việc idempotent: chạy lại không tạo thêm thông báo/báo cáo trùng.
 */

async function orgIds() {
  return (await query<{ id: string }>("SELECT id FROM organizations ORDER BY created_at")).map((r) => r.id);
}

export async function runEscalationJob(at: Date = now()) {
  const total = { tickets: 0, handoffs: 0, callbacks: 0, notifications: 0 };
  for (const orgId of await orgIds()) {
    const t = await escalateOverdueTickets(orgId, at);
    const h = await escalateOverdueHandoffs(orgId, at);
    total.tickets += t.tickets;
    total.handoffs += h.handoffs;
    total.callbacks += h.callbacks;
    total.notifications += t.notifications + h.notifications;
  }
  return total;
}

export async function runSystemAlertJob(at: Date = now()) {
  let notifications = 0;
  for (const orgId of await orgIds()) notifications += (await raiseSystemAlerts(orgId, at)).notifications;
  return { notifications };
}

/** Cửa sổ gửi báo cáo theo lịch: trễ tối đa bấy nhiêu phút sau giờ đăng ký vẫn gửi (worker tắt lâu hơn thì bỏ lượt đó). */
const REPORT_WINDOW_MINUTES = 30;

/**
 * Báo cáo theo lịch đăng ký (mặc định TẮT; lịch 08:00/20:00 là đề xuất cần Ngọc/Dịu chốt).
 * Cần công tắc kênh report_delivery + trợ lý manager đang bật. Mỗi người/ngày/loại chỉ xếp một tin.
 */
export async function runScheduledReportsJob(at: Date = now()) {
  const stats = { reports: 0, notifications: 0 };
  const subs = await query<{ id: string; org_id: string; user_id: string; kind: ReportKind; channel: "whatsapp" | "inapp"; send_time: string; timezone: string }>(
    `SELECT s.id, s.org_id, s.user_id, s.kind, s.channel, s.send_time::text, o.timezone
       FROM report_subscriptions s JOIN organizations o ON o.id = s.org_id
       JOIN users u ON u.id = s.user_id AND u.org_id = s.org_id AND u.active
      WHERE s.enabled AND s.kind IN ('morning','evening') AND s.send_time IS NOT NULL`,
  );
  const built = new Map<string, { id: string; preview: string }>();
  for (const s of subs) {
    const date = localDateOf(at, s.timezone);
    const [h, m] = localTimeOf(at, s.timezone).split(":").map(Number);
    const [sh, sm] = s.send_time.split(":").map(Number);
    const minutesAfter = h * 60 + m - (sh * 60 + sm);
    if (minutesAfter < 0 || minutesAfter > REPORT_WINDOW_MINUTES) continue;
    const dedupeKey = `report:${date}:${s.kind}:${s.channel}:${s.user_id}`;
    const already = await queryOne("SELECT 1 FROM staff_notifications WHERE org_id = $1 AND dedupe_key = $2", [s.org_id, dedupeKey]);
    if (already) continue;
    const sw = await isPaused(s.org_id, [
      { scope: "channel", key: "report_delivery" },
      { scope: "agent", key: "manager" },
    ]);
    if (sw.paused) continue;
    const cacheKey = `${s.org_id}:${date}:${s.kind}`;
    let report = built.get(cacheKey);
    if (!report) {
      const r = await buildDailyReport(s.org_id, s.kind, date, { cutoff: at });
      report = { id: r.id, preview: reportWhatsAppPreview(r.data) };
      built.set(cacheKey, report);
      stats.reports += 1;
    }
    const res = await withTx((tx) =>
      enqueueStaffNotification(tx, {
        orgId: s.org_id,
        recipientUserId: s.user_id,
        templateKey: "daily_report",
        payload: { report_id: report.id, date: formatDateVi(date), kind_label: REPORT_KIND_LABELS[s.kind], summary: report.preview, link: `/bao-cao?id=${report.id}` },
        dedupeKey,
        channel: s.channel,
      }),
    );
    if (!res.duplicate) stats.notifications += 1;
  }
  return stats;
}

export const periodic: PeriodicJob[] = [
  { name: "manager.escalation", everyMs: 30_000, run: () => runEscalationJob() },
  { name: "notifications.send", everyMs: 15_000, run: () => sendQueuedNotifications() },
  { name: "manager.system_alerts", everyMs: 5 * 60_000, run: () => runSystemAlertJob() },
  { name: "manager.scheduled_reports", everyMs: 60_000, run: () => runScheduledReportsJob() },
];
