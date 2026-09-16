import { query, queryOne } from "@/lib/db";
import { isPaused } from "@/modules/automation/switches";
import { sendWhatsAppText } from "@/modules/inbox/transport";

/**
 * Bộ gửi thông báo cho đội (worker gọi định kỳ). Hàng đợi do `enqueueStaffNotification` ghi.
 * Mỗi tin đi qua lần lượt các chốt; trượt chốt nào thì ghi `suppressed` + mã lý do, KHÔNG âm thầm bỏ:
 *   1. công tắc: kênh whatsapp_staff + trợ lý manager (mặc định DỪNG)
 *   2. mẫu tin key + ngôn ngữ đã duyệt; điền đủ trường
 *   3. người nhận có số điện thoại
 *   4. tổ chức có connector WhatsApp đang hoạt động/thử nghiệm
 *   5. số đó từng nhắn vào tổng đài (WhatsApp dễ gỡ thiết bị khi nhắn số lạ)
 *   6. hạn mức: ≤ 20 tin/giờ/tổ chức, ≤ 1 tin/phút/người
 * Chỉ ghi `sent` khi transport trả ok kèm mã tin. Transport lỗi ⇒ `failed` kèm lý do.
 */

export type WhatsAppTransport = (orgId: string, connectorId: string, toJidOrPhone: string, text: string, opts?: { maxWaitMs?: number }) => Promise<{ ok: true; externalId: string } | { ok: false; reason: string }>;

export const RATE_LIMIT_PER_ORG_HOUR = 20;
export const RATE_LIMIT_PER_RECIPIENT_MS = 60_000;
/** Tin giành quyền gửi (`locked_at`) quá mức này mà vẫn `sending`: tiến trình chết giữa chừng — không biết đã gửi hay chưa, không tự gửi lại. */
const SENDING_STUCK_SECONDS = 120;

export const SUPPRESSED_REASON_LABELS: Record<string, string> = {
  paused: "Công tắc tự động đang dừng",
  template_not_approved: "Mẫu tin chưa được duyệt",
  template_missing_field: "Thiếu dữ liệu để điền mẫu",
  recipient_no_phone: "Người nhận chưa có số điện thoại",
  recipient_inactive: "Tài khoản người nhận đã khoá",
  no_connector: "Chưa có kết nối WhatsApp hoạt động",
  recipient_never_messaged: "Số này chưa từng nhắn vào tổng đài",
  rate_limit_org: `Vượt hạn mức ${RATE_LIMIT_PER_ORG_HOUR} tin/giờ của tổ chức`,
  rate_limit_recipient: "Vượt hạn mức 1 tin/phút cho một người",
};

interface QueuedRow {
  id: string;
  org_id: string;
  recipient_user_id: string;
  channel: "whatsapp" | "inapp";
  template_key: string;
  payload: Record<string, unknown>;
  created_at?: Date;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Điền `{{field}}` từ payload. Trường thiếu ⇒ trả danh sách thiếu, không gửi câu rỗng. */
export function renderTemplate(body: string, payload: Record<string, unknown>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, field: string) => {
    const v = payload[field];
    if (v === undefined || v === null || v === "") {
      missing.push(field);
      return "";
    }
    return String(v);
  });
  return { text, missing: [...new Set(missing)] };
}

async function suppress(id: string, reason: string, detail: string | null = null) {
  await query("UPDATE staff_notifications SET status = 'suppressed', suppressed_reason = $2, error = $3 WHERE id = $1 AND status = 'sending'", [id, reason, detail]);
  return "suppressed" as const;
}

export async function processOneNotification(n: QueuedRow, transport: WhatsAppTransport | null): Promise<"sent" | "suppressed" | "failed" | "deferred"> {
  const user = await queryOne<{ phone: string | null; locale: string; active: boolean }>("SELECT phone, locale, active FROM users WHERE id = $1 AND org_id = $2", [
    n.recipient_user_id,
    n.org_id,
  ]);
  if (!user || !user.active) return suppress(n.id, "recipient_inactive");

  const template = await queryOne<{ body: string; status: string; language: string }>(
    `SELECT body, status, language FROM message_templates WHERE org_id = $1 AND key = $2 AND language IN ($3, 'vi')
      ORDER BY (language = $3) DESC LIMIT 1`,
    [n.org_id, n.template_key, user.locale],
  );

  // Trong app: không ra ngoài, chỉ hiện trong ứng dụng — không cần công tắc/hạn mức kênh WhatsApp.
  if (n.channel === "inapp") {
    const rendered = template && template.status === "approved" ? renderTemplate(template.body, n.payload).text : null;
    await query("UPDATE staff_notifications SET status = 'sent', sent_at = now(), rendered_body = $2, attempts = attempts + 1 WHERE id = $1 AND status = 'sending'", [n.id, rendered]);
    return "sent";
  }

  const sw = await isPaused(n.org_id, [
    { scope: "channel", key: "whatsapp_staff" },
    { scope: "agent", key: "manager" },
  ]);
  if (sw.paused) return suppress(n.id, "paused", sw.reason);

  if (!template || template.status !== "approved") return suppress(n.id, "template_not_approved", template ? `Mẫu ${n.template_key} (${template.language}) đang ${template.status}` : `Chưa có mẫu ${n.template_key}`);
  const rendered = renderTemplate(template.body, n.payload);
  if (rendered.missing.length) return suppress(n.id, "template_missing_field", rendered.missing.join(", "));

  const phone = digits(user.phone ?? "");
  if (phone.length < 6) return suppress(n.id, "recipient_no_phone");

  const connector = await queryOne<{ id: string }>(
    "SELECT id FROM connector_accounts WHERE org_id = $1 AND channel = 'whatsapp' AND status IN ('active','testing') AND NOT paused ORDER BY status = 'active' DESC, created_at LIMIT 1",
    [n.org_id],
  );
  if (!connector) return suppress(n.id, "no_connector");

  const inbound = await queryOne<{ id: string }>(
    `SELECT id FROM conversations
      WHERE org_id = $1 AND channel = 'whatsapp' AND last_inbound_at IS NOT NULL
        AND (staff_user_id = $2
             OR regexp_replace(coalesce(contact_handle, ''), '\\D', '', 'g') = $3
             OR regexp_replace(split_part(external_thread_id, '@', 1), '\\D', '', 'g') = $3)
      LIMIT 1`,
    [n.org_id, n.recipient_user_id, phone],
  );
  if (!inbound) return suppress(n.id, "recipient_never_messaged");

  const rate = await queryOne<{ org_hour: number; recipient_recent: number }>(
    `SELECT count(*) FILTER (WHERE sent_at > now() - interval '1 hour')::int AS org_hour,
            count(*) FILTER (WHERE recipient_user_id = $2 AND sent_at > now() - make_interval(secs => $3))::int AS recipient_recent
       FROM staff_notifications WHERE org_id = $1 AND channel = 'whatsapp' AND status = 'sent'`,
    [n.org_id, n.recipient_user_id, RATE_LIMIT_PER_RECIPIENT_MS / 1000],
  );
  if ((rate?.org_hour ?? 0) >= RATE_LIMIT_PER_ORG_HOUR) return suppress(n.id, "rate_limit_org");
  if ((rate?.recipient_recent ?? 0) > 0) return suppress(n.id, "rate_limit_recipient");

  if (!transport) {
    await query("UPDATE staff_notifications SET status = 'failed', error = $2, attempts = attempts + 1, rendered_body = $3 WHERE id = $1 AND status = 'sending'", [
      n.id,
      "Chưa có bộ gửi WhatsApp (transport) trong bản chạy này",
      rendered.text,
    ]);
    return "failed";
  }
  let result: Awaited<ReturnType<WhatsAppTransport>>;
  try {
    // Không đứng chờ lượt: khoảng cách 3 giây/số tổng đài tính theo DB trong transport (dùng chung với hộp thư).
    result = await transport(n.org_id, connector.id, phone, rendered.text, { maxWaitMs: 0 });
  } catch (error) {
    result = { ok: false, reason: (error as Error).message ?? String(error) };
  }
  if (result.ok && result.externalId) {
    await query(
      "UPDATE staff_notifications SET status = 'sent', sent_at = now(), external_message_id = $2, rendered_body = $3, attempts = attempts + 1, error = NULL WHERE id = $1 AND status = 'sending'",
      [n.id, result.externalId, rendered.text],
    );
    return "sent";
  }
  if (!result.ok && result.reason === "rate_limited") {
    // Chắc chắn CHƯA gửi (chưa tới lượt của số tổng đài) ⇒ trả về hàng đợi, lượt sau thử lại.
    await query("UPDATE staff_notifications SET status = 'queued', locked_at = NULL WHERE id = $1 AND status = 'sending'", [n.id]);
    return "deferred";
  }
  // Lưu mã lỗi gốc (giao diện đổi sang chữ bằng sendFailureLabel). Lỗi không chắc chắn (hết giờ, 5xx) cũng không tự gửi lại.
  const reason = result.ok ? "no_message_id" : result.reason;
  await query("UPDATE staff_notifications SET status = 'failed', error = $2, attempts = attempts + 1, rendered_body = $3 WHERE id = $1 AND status = 'sending'", [
    n.id,
    reason.slice(0, 500),
    rendered.text,
  ]);
  return "failed";
}

/**
 * Xử lý một lô tin đang chờ. Mỗi tin được "nhận" bằng UPDATE queued→sending trước khi kiểm, nên hai worker
 * không gửi trùng một tin. `transport` tiêm vào để kiểm thử; mặc định `sendWhatsAppText` của hộp thư.
 */
export async function sendQueuedNotifications(opts: { transport?: WhatsAppTransport | null; limit?: number; orgId?: string } = {}) {
  const stats = { sent: 0, suppressed: 0, failed: 0, deferred: 0, stuck: 0 };
  const stuck = await query<{ id: string }>(
    `UPDATE staff_notifications SET status = 'failed', error = 'Gián đoạn khi đang gửi — không rõ đã tới người nhận chưa, không tự gửi lại'
      WHERE status = 'sending' AND coalesce(locked_at, created_at) < now() - make_interval(secs => $1) ${opts.orgId ? "AND org_id = $2" : ""} RETURNING id`,
    opts.orgId ? [SENDING_STUCK_SECONDS, opts.orgId] : [SENDING_STUCK_SECONDS],
  );
  stats.stuck = stuck.length;

  const batch = await query<QueuedRow>(
    `UPDATE staff_notifications SET status = 'sending', locked_at = now()
      WHERE id IN (SELECT id FROM staff_notifications WHERE status = 'queued' ${opts.orgId ? "AND org_id = $2" : ""}
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, org_id, recipient_user_id, channel, template_key, payload, created_at`,
    opts.orgId ? [opts.limit ?? 50, opts.orgId] : [opts.limit ?? 50],
  );
  if (batch.length === 0) return stats;

  const transport: WhatsAppTransport | null = opts.transport === undefined ? sendWhatsAppText : opts.transport;
  // Giữ thứ tự tạo để hạn mức tính đúng.
  batch.sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime());
  for (const n of batch) {
    try {
      stats[await processOneNotification(n, transport)] += 1;
    } catch (error) {
      await query("UPDATE staff_notifications SET status = 'failed', error = $2, attempts = attempts + 1 WHERE id = $1 AND status = 'sending'", [
        n.id,
        `Lỗi bộ gửi: ${(error as Error).message}`.slice(0, 500),
      ]);
      stats.failed += 1;
    }
  }
  return stats;
}
