import type { Queryable } from "@/lib/db";
import { emit } from "@/modules/outbox/outbox";

/**
 * HỢP ĐỒNG DÙNG CHUNG (orchestrator sở hữu chữ ký; module manager viết phần gửi).
 * Mọi module muốn báo cho người trong đội (Thảo, Ngọc, cleaner...) gọi hàm này TRONG giao dịch nghiệp vụ.
 * Hàm chỉ xếp hàng — không gửi. Bộ gửi (worker) mới kiểm công tắc, mẫu tin đã duyệt, hạn mức, rồi gửi hoặc
 * ghi `suppressed` kèm lý do. Cùng dedupeKey chỉ xếp một lần.
 */
export interface StaffNotificationInput {
  orgId: string;
  recipientUserId: string;
  templateKey: string;
  payload: Record<string, unknown>;
  /** Ví dụ `ticket:<id>:escalate:1` — gửi lại cùng khoá sẽ không tạo tin thứ hai. */
  dedupeKey: string;
  channel?: "whatsapp" | "inapp";
}

export async function enqueueStaffNotification(tx: Queryable, n: StaffNotificationInput): Promise<{ id: string | null; duplicate: boolean }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO staff_notifications (org_id, recipient_user_id, channel, template_key, payload, dedupe_key)
     SELECT $1, u.id, $3, $4, $5, $6 FROM users u WHERE u.id = $2 AND u.org_id = $1
     ON CONFLICT (org_id, dedupe_key) DO NOTHING RETURNING id`,
    [n.orgId, n.recipientUserId, n.channel ?? "whatsapp", n.templateKey, JSON.stringify(n.payload), n.dedupeKey],
  );
  if (!rows[0]) return { id: null, duplicate: true };
  await emit(tx, {
    orgId: n.orgId,
    topic: "staff_notification.queued",
    aggregateType: "staff_notification",
    aggregateId: rows[0].id,
    payload: { templateKey: n.templateKey },
    dedupeKey: `staff_notification:${rows[0].id}`,
  });
  return { id: rows[0].id, duplicate: false };
}
