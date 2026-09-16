import { type Queryable, query, withTx } from "@/lib/db";
import { now } from "@/lib/time";
import { enqueueStaffNotification } from "@/modules/notifications/enqueue";
import { STALE_SYNC_HOURS } from "./report";

/**
 * Cảnh báo không đợi báo cáo (đặc tả mục 5): việc khẩn chưa ai nhận thì đẩy lên người dự phòng rồi Leader.
 * Chỉ XẾP HÀNG thông báo — bộ gửi mới kiểm công tắc/mẫu/hạn mức. Mọi bước idempotent: chạy lại cùng thời điểm
 * không tạo thêm thông báo (khoá chống trùng theo đối tượng + cấp + người nhận, và hạn nhận được dời sau mỗi cấp).
 */

export const ESCALATION_PURPOSES = ["guest_support", "maintenance", "cleaning", "booking", "finance", "technical", "management"] as const;
export type EscalationPurpose = (typeof ESCALATION_PURPOSES)[number];

export const PURPOSE_LABELS: Record<EscalationPurpose, string> = {
  guest_support: "Hỗ trợ khách",
  maintenance: "Sửa chữa / bảo trì",
  cleaning: "Cleaning",
  booking: "Booking",
  finance: "Tiền / hoàn tiền",
  technical: "Kỹ thuật hệ thống",
  management: "Quản lý",
};

/** Ticket theo loại → mục đích người trực. */
export const TICKET_PURPOSE: Record<string, EscalationPurpose> = {
  access: "guest_support",
  maintenance: "maintenance",
  cleaning: "cleaning",
  amenities: "guest_support",
  booking_change: "booking",
  payment_refund: "finance",
  complaint: "guest_support",
  question: "guest_support",
  other: "guest_support",
};

/** Handoff theo loại ticket gắn kèm (sự cố vào phòng/sửa chữa ⇒ bảo trì; tiền/đổi booking ⇒ booking). */
export const HANDOFF_PURPOSE: Record<string, EscalationPurpose> = {
  access: "maintenance",
  maintenance: "maintenance",
  payment_refund: "booking",
  booking_change: "booking",
};

/** Hạn nhận cho cấp kế tiếp (phút). Đề xuất theo đặc tả: P1 nhận trong 5 phút — cần đội vận hành chốt. */
export const ESCALATION_STEP_MINUTES = 5;

interface Recipient {
  user_id: string;
}

/** Người nhận ở một cấp. Cấp vượt quá cấu hình ⇒ Leader (không có Leader thì quản trị). */
export async function recipientsForLevel(tx: Queryable, orgId: string, purpose: EscalationPurpose, level: number): Promise<{ users: string[]; beyondConfig: boolean }> {
  const { rows } = await tx.query<Recipient>(
    `SELECT ec.user_id FROM escalation_contacts ec JOIN users u ON u.id = ec.user_id AND u.org_id = ec.org_id AND u.active
      WHERE ec.org_id = $1 AND ec.purpose = $2 AND ec.level = $3 AND ec.active ORDER BY u.full_name`,
    [orgId, purpose, level],
  );
  if (rows.length) return { users: rows.map((r) => r.user_id), beyondConfig: false };
  const higher = await tx.query("SELECT 1 FROM escalation_contacts WHERE org_id = $1 AND purpose = $2 AND level > $3 AND active LIMIT 1", [orgId, purpose, level]);
  if (higher.rows.length) return { users: [], beyondConfig: false };
  return { users: await topOfChain(tx, orgId), beyondConfig: true };
}

async function topOfChain(tx: Queryable, orgId: string): Promise<string[]> {
  const leaders = await tx.query<Recipient>("SELECT id AS user_id FROM users WHERE org_id = $1 AND role = 'leader' AND active ORDER BY full_name", [orgId]);
  if (leaders.rows.length) return leaders.rows.map((r) => r.user_id);
  const admins = await tx.query<Recipient>("SELECT id AS user_id FROM users WHERE org_id = $1 AND role = 'admin' AND active ORDER BY full_name", [orgId]);
  return admins.rows.map((r) => r.user_id);
}

/** Mục đích chưa có ai trực (đang bật, tài khoản còn hoạt động) ⇒ rơi về hỗ trợ khách; hỗ trợ khách cũng trống thì chuỗi đi thẳng lên Leader. */
export async function effectivePurpose(tx: Queryable, orgId: string, purpose: EscalationPurpose): Promise<EscalationPurpose> {
  if (purpose === "guest_support") return purpose;
  const { rows } = await tx.query(
    "SELECT 1 FROM escalation_contacts ec JOIN users u ON u.id = ec.user_id AND u.org_id = ec.org_id AND u.active WHERE ec.org_id = $1 AND ec.purpose = $2 AND ec.active LIMIT 1",
    [orgId, purpose],
  );
  return rows.length ? purpose : "guest_support";
}

async function minConfiguredLevel(tx: Queryable, orgId: string, purpose: EscalationPurpose): Promise<number> {
  const { rows } = await tx.query<{ m: number | null }>("SELECT min(level) AS m FROM escalation_contacts WHERE org_id = $1 AND purpose = $2 AND active", [orgId, purpose]);
  return rows[0]?.m ?? 0;
}

async function maxConfiguredLevel(tx: Queryable, orgId: string, purpose: EscalationPurpose): Promise<number> {
  const { rows } = await tx.query<{ m: number | null }>("SELECT max(level) AS m FROM escalation_contacts WHERE org_id = $1 AND purpose = $2 AND active", [orgId, purpose]);
  return rows[0]?.m ?? -1;
}

/** Ticket P0/P1 quá hạn nhận mà chưa ai nhận ⇒ lên một cấp. Cấp đã vượt Leader thì dừng (đã báo người cao nhất). */
export async function escalateOverdueTickets(orgId: string, at: Date = now()) {
  const stats = { tickets: 0, notifications: 0 };
  const due = await query<{ id: string }>(
    `SELECT id FROM tickets WHERE org_id = $1 AND priority IN ('P0','P1') AND status IN ('new','assigned')
        AND accept_due_at IS NOT NULL AND accept_due_at < $2 ORDER BY accept_due_at LIMIT 100`,
    [orgId, at],
  );
  for (const { id } of due) {
    await withTx(async (tx) => {
      const { rows } = await tx.query<{ id: string; priority: string; category: string; summary: string; status: string; escalation_level: number; accept_due_at: Date | null; conversation_id: string | null }>(
        "SELECT id, priority, category, summary, status, escalation_level, accept_due_at, conversation_id FROM tickets WHERE id = $1 AND org_id = $2 FOR UPDATE",
        [id, orgId],
      );
      const t = rows[0];
      // Kiểm lại sau khi khoá: người khác vừa nhận, hoặc lượt chạy trước vừa dời hạn.
      if (!t || !["new", "assigned"].includes(t.status) || !t.accept_due_at || new Date(t.accept_due_at) >= at) return;
      const purpose = await effectivePurpose(tx, orgId, TICKET_PURPOSE[t.category] ?? "guest_support");
      const maxLevel = await maxConfiguredLevel(tx, orgId, purpose);
      // Đã báo tới cấp Leader (cấp > cấu hình) mà vẫn chưa nhận: không đẩy tiếp vô hạn.
      if (t.escalation_level > Math.max(maxLevel, 0)) return;
      const level = t.escalation_level + 1;
      const { users } = await recipientsForLevel(tx, orgId, purpose, level);
      const overdueMinutes = Math.max(0, Math.round((at.getTime() - new Date(t.accept_due_at).getTime()) / 60_000));
      for (const userId of users) {
        const r = await enqueueStaffNotification(tx, {
          orgId,
          recipientUserId: userId,
          templateKey: "ticket_escalation",
          payload: { ticket_id: t.id, priority: t.priority, category: t.category, summary: t.summary, level, overdue_minutes: overdueMinutes, link: t.conversation_id ? `/hop-thu?c=${t.conversation_id}` : "/hop-thu" },
          dedupeKey: `ticket:${t.id}:esc:${level}:${userId}`,
        });
        if (!r.duplicate) stats.notifications += 1;
      }
      await tx.query(
        `UPDATE tickets SET escalation_level = $3, escalated_at = $4, accept_due_at = $4::timestamptz + make_interval(mins => $5),
                version = version + 1, updated_at = now()
          WHERE id = $1 AND org_id = $2 AND escalation_level = $6`,
        [t.id, orgId, level, at, ESCALATION_STEP_MINUTES, t.escalation_level],
      );
      stats.tickets += 1;
    });
  }
  return stats;
}

/**
 * Yêu cầu chuyển người (handoff) quá hạn nhận ⇒ báo cấp kế tiếp theo mục đích suy từ ticket gắn kèm (HANDOFF_PURPOSE;
 * chưa có người trực thì hỗ trợ khách). Handoff đã nhận/huỷ/hẹn gọi lại (kể cả đóng do tiếp quản) không bị đẩy.
 * Hết cấp cấu hình ⇒ trạng thái `callback` (hẹn gọi lại) và báo Leader; KHÔNG bao giờ ghi là đã kết nối.
 * Cấp hiện tại lưu ở `handoffs.escalation_level` (0 = người nhận đầu tiên do hộp thư báo).
 */
export async function escalateOverdueHandoffs(orgId: string, at: Date = now()) {
  const stats = { handoffs: 0, callbacks: 0, notifications: 0 };
  const due = await query<{ id: string }>(
    `SELECT id FROM handoffs WHERE org_id = $1 AND status IN ('requested','escalated') AND accept_due_at IS NOT NULL AND accept_due_at < $2
      ORDER BY accept_due_at LIMIT 100`,
    [orgId, at],
  );
  for (const { id } of due) {
    await withTx(async (tx) => {
      const { rows } = await tx.query<{ id: string; status: string; reason: string; conversation_id: string; accept_due_at: Date | null; escalation_level: number; category: string | null; priority: string | null }>(
        `SELECT h.id, h.status, h.reason, h.conversation_id, h.accept_due_at, h.escalation_level, t.category, t.priority
           FROM handoffs h LEFT JOIN tickets t ON t.id = h.ticket_id AND t.org_id = h.org_id
          WHERE h.id = $1 AND h.org_id = $2 FOR UPDATE OF h`,
        [id, orgId],
      );
      const h = rows[0];
      if (!h || !["requested", "escalated"].includes(h.status) || !h.accept_due_at || new Date(h.accept_due_at) >= at) return;
      const purpose = await effectivePurpose(tx, orgId, (h.category && HANDOFF_PURPOSE[h.category]) || "guest_support");
      // Cấp đầu thực tế là cấp thấp nhất đã cấu hình (hộp thư báo cấp đó) — không báo lại cùng người.
      const level = Math.max(h.escalation_level, await minConfiguredLevel(tx, orgId, purpose)) + 1;
      const maxLevel = await maxConfiguredLevel(tx, orgId, purpose);
      const basePayload = { handoff_id: h.id, reason: h.reason, level, purpose, ...(h.priority ? { priority: h.priority } : {}), link: `/hop-thu?c=${h.conversation_id}` };
      if (level > maxLevel) {
        // Hết người dự phòng: hẹn gọi lại, báo người cao nhất để sắp xếp.
        await tx.query("UPDATE handoffs SET status = 'callback', escalation_level = $3, escalated_at = $4 WHERE id = $1 AND org_id = $2 AND status IN ('requested','escalated')", [h.id, orgId, level, at]);
        for (const userId of await topOfChain(tx, orgId)) {
          const r = await enqueueStaffNotification(tx, {
            orgId,
            recipientUserId: userId,
            templateKey: "handoff_request",
            payload: { ...basePayload, callback: "yes" },
            dedupeKey: `handoff:${h.id}:callback:${userId}`,
          });
          if (!r.duplicate) stats.notifications += 1;
        }
        stats.callbacks += 1;
        return;
      }
      const { users } = await recipientsForLevel(tx, orgId, purpose, level);
      for (const userId of users) {
        const r = await enqueueStaffNotification(tx, {
          orgId,
          recipientUserId: userId,
          templateKey: "handoff_request",
          payload: basePayload,
          dedupeKey: `handoff:${h.id}:esc:${level}:${userId}`,
        });
        if (!r.duplicate) stats.notifications += 1;
      }
      await tx.query(
        "UPDATE handoffs SET status = 'escalated', escalation_level = $5, escalated_at = $3, accept_due_at = $3::timestamptz + make_interval(mins => $4) WHERE id = $1 AND org_id = $2",
        [h.id, orgId, at, ESCALATION_STEP_MINUTES, level],
      );
      stats.handoffs += 1;
    });
  }
  return stats;
}

/**
 * Cảnh báo kỹ thuật (thông báo TRONG APP cho người trực kỹ thuật, không có thì quản trị):
 * connector hoạt động/thử nghiệm không đồng bộ thành công quá 6 giờ, sự kiện nền hỏng (dead), worker mất nhịp.
 */
export async function raiseSystemAlerts(orgId: string, at: Date = now(), opts: { workerLastBeat?: Date | null } = {}) {
  const stats = { notifications: 0 };
  await withTx(async (tx) => {
    const recipients = await technicalRecipients(tx, orgId);
    if (recipients.length === 0) return;
    const push = async (key: string, templateKey: string, payload: Record<string, unknown>) => {
      for (const userId of recipients) {
        const r = await enqueueStaffNotification(tx, { orgId, recipientUserId: userId, templateKey, payload, dedupeKey: `${key}:${userId}`, channel: "inapp" });
        if (!r.duplicate) stats.notifications += 1;
      }
    };

    const staleBefore = new Date(at.getTime() - STALE_SYNC_HOURS * 3600_000);
    const { rows: stale } = await tx.query<{ id: string; label: string; last_success_at: Date | null }>(
      `SELECT id, label, last_success_at FROM connector_accounts
        WHERE org_id = $1 AND status IN ('active','testing') AND NOT paused AND channel <> 'whatsapp' AND coalesce(last_success_at, created_at) < $2`,
      [orgId, staleBefore],
    );
    for (const c of stale) {
      // Một lần cho mỗi đợt mất đồng bộ (mốc thành công gần nhất) — đồng bộ lại rồi mất lần nữa thì báo lại.
      const since = c.last_success_at ? new Date(c.last_success_at).toISOString() : "never";
      await push(`connector:${c.id}:stale:${since}`, "system_alert", {
        kind: "connector_stale",
        title: `Kết nối ${c.label} không đồng bộ thành công quá ${STALE_SYNC_HOURS} giờ`,
        last_success_at: c.last_success_at ? new Date(c.last_success_at).toISOString() : null,
        link: "/ket-noi",
      });
    }

    const { rows: dead } = await tx.query<{ n: number; latest: string | null }>(
      `SELECT count(*)::int AS n, (SELECT id::text FROM outbox_events WHERE org_id = $1 AND status = 'dead' ORDER BY created_at DESC LIMIT 1) AS latest
         FROM outbox_events WHERE org_id = $1 AND status = 'dead'`,
      [orgId],
    );
    if (dead[0]?.n && dead[0].latest) {
      await push(`outbox:dead:${dead[0].latest}`, "system_alert", { kind: "outbox_dead", title: `${dead[0].n} sự kiện nền hỏng cần xem`, count: dead[0].n, link: "/agent-center?tab=outbox" });
    }

    if (opts.workerLastBeat !== undefined) {
      const beat = opts.workerLastBeat;
      if (!beat || at.getTime() - beat.getTime() > 2 * 60_000) {
        const mark = beat ? beat.toISOString() : "never";
        await push(`worker:stale:${mark}`, "system_alert", { kind: "worker_stale", title: "Worker nền mất nhịp quá 2 phút", last_beat_at: beat ? beat.toISOString() : null, link: "/agent-center" });
      }
    }
  });
  return stats;
}

async function technicalRecipients(tx: Queryable, orgId: string): Promise<string[]> {
  const { rows } = await tx.query<Recipient>(
    `SELECT ec.user_id FROM escalation_contacts ec JOIN users u ON u.id = ec.user_id AND u.org_id = ec.org_id AND u.active
      WHERE ec.org_id = $1 AND ec.purpose = 'technical' AND ec.active AND ec.level = (
        SELECT min(level) FROM escalation_contacts WHERE org_id = $1 AND purpose = 'technical' AND active)`,
    [orgId],
  );
  if (rows.length) return rows.map((r) => r.user_id);
  const admins = await tx.query<Recipient>("SELECT id AS user_id FROM users WHERE org_id = $1 AND role = 'admin' AND active", [orgId]);
  return admins.rows.map((r) => r.user_id);
}
