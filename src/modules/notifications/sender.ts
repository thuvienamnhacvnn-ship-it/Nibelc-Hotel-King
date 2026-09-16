import { query, queryOne } from "@/lib/db";
import { isPaused } from "@/modules/automation/switches";
import { nextHourSlotAt, sendWhatsAppText } from "@/modules/inbox/transport";

/**
 * Bộ gửi thông báo cho đội (worker gọi định kỳ). Hàng đợi do `enqueueStaffNotification` ghi.
 * Mỗi tin đi qua lần lượt các chốt; trượt chốt nào thì ghi `suppressed` + mã lý do, KHÔNG âm thầm bỏ:
 *   1. công tắc: kênh whatsapp_staff + trợ lý manager (mặc định DỪNG); báo cáo ngày thêm kênh report_delivery
 *   2. mẫu tin key + ngôn ngữ đã duyệt; điền đủ trường
 *   3. người nhận có số điện thoại
 *   4. tổ chức có connector WhatsApp đang hoạt động/thử nghiệm
 *   5. số đó từng nhắn vào ĐÚNG connector sẽ dùng để gửi (WhatsApp dễ gỡ thiết bị khi nhắn số lạ)
 * Hạn mức KHÔNG làm mất tin: 1 tin/phút/người (cảnh báo P0/P1 được vượt) và trần của số tổng đài
 * (`reserveSendSlot` trong transport, dùng chung với hộp thư) ⇒ tin quay lại `queued` chờ lượt sau.
 * Chỉ ghi `sent` khi transport trả ok kèm mã tin. Transport lỗi ⇒ `failed` kèm lý do, không tự gửi lại.
 *
 * Chống gửi trùng khi có hai tiến trình: giành TỪNG tin (queued→sending, đặt `locked_at`), và ngay trước khi gọi
 * transport làm mới `locked_at` bằng compare-and-set trên giá trị mình đã đặt — tin đã bị tiến trình khác đổi thì bỏ.
 * `locked_at` chỉ có nghĩa khi `sending`; hoãn theo hạn mức bằng `available_at` tương lai (migration 0008).
 * Ghi `connector_id` lúc sắp gửi để trần theo giờ trong `reserveSendSlot` đếm chung với tin hộp thư của cùng số.
 */

export type WhatsAppTransport = (orgId: string, connectorId: string, toJidOrPhone: string, text: string, opts?: { maxWaitMs?: number }) => Promise<{ ok: true; externalId: string } | { ok: false; reason: string }>;

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
};

interface QueuedRow {
  id: string;
  org_id: string;
  recipient_user_id: string;
  channel: "whatsapp" | "inapp";
  template_key: string;
  payload: Record<string, unknown>;
  /** Giá trị locked_at mình đặt khi giành tin (chuỗi đủ độ chính xác micro giây) */
  lock: string;
}

type Outcome = "sent" | "suppressed" | "failed" | "deferred" | "lost";

/** Tiến trình này đang giữ những tin nào — việc dọn tin kẹt không đụng tới chúng. */
const heldByMe = new Set<string>();

const digits = (s: string) => s.replace(/\D/g, "");

/** Cảnh báo khẩn được vượt giới hạn 1 tin/phút/người (vẫn chịu trần chung của số tổng đài). */
export function isUrgent(payload: Record<string, unknown>) {
  return payload.priority === "P0" || payload.priority === "P1";
}

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

const MINE = "id = $1 AND status = 'sending' AND locked_at = $2::timestamptz";

async function suppress(n: QueuedRow, reason: string, detail: string | null = null): Promise<Outcome> {
  const rows = await query(`UPDATE staff_notifications SET status = 'suppressed', suppressed_reason = $3, error = $4, locked_at = NULL WHERE ${MINE} RETURNING id`, [n.id, n.lock, reason, detail]);
  return rows.length ? "suppressed" : "lost";
}

async function defer(n: QueuedRow, after: number | Date): Promise<Outcome> {
  const rows =
    typeof after === "number"
      ? await query(`UPDATE staff_notifications SET status = 'queued', locked_at = NULL, available_at = now() + make_interval(secs => $3) WHERE ${MINE} RETURNING id`, [n.id, n.lock, after])
      : await query(`UPDATE staff_notifications SET status = 'queued', locked_at = NULL, available_at = greatest($3::timestamptz, now() + interval '5 seconds') WHERE ${MINE} RETURNING id`, [n.id, n.lock, after]);
  return rows.length ? "deferred" : "lost";
}

async function fail(n: QueuedRow, error: string, rendered: string | null): Promise<Outcome> {
  const rows = await query(
    `UPDATE staff_notifications SET status = 'failed', error = $3, attempts = attempts + 1, rendered_body = coalesce($4, rendered_body), locked_at = NULL WHERE ${MINE} RETURNING id`,
    [n.id, n.lock, error.slice(0, 500), rendered],
  );
  return rows.length ? "failed" : "lost";
}

export async function processOneNotification(n: QueuedRow, transport: WhatsAppTransport | null): Promise<Outcome> {
  const user = await queryOne<{ phone: string | null; locale: string; active: boolean }>("SELECT phone, locale, active FROM users WHERE id = $1 AND org_id = $2", [
    n.recipient_user_id,
    n.org_id,
  ]);
  if (!user || !user.active) return suppress(n, "recipient_inactive");

  const template = await queryOne<{ body: string; status: string; language: string }>(
    `SELECT body, status, language FROM message_templates WHERE org_id = $1 AND key = $2 AND language IN ($3, 'vi')
      ORDER BY (language = $3) DESC LIMIT 1`,
    [n.org_id, n.template_key, user.locale],
  );

  // Trong app: không ra ngoài, chỉ hiện trong ứng dụng — không cần công tắc/hạn mức kênh WhatsApp.
  if (n.channel === "inapp") {
    const rendered = template && template.status === "approved" ? renderTemplate(template.body, n.payload).text : null;
    const rows = await query(`UPDATE staff_notifications SET status = 'sent', sent_at = now(), rendered_body = $3, attempts = attempts + 1, locked_at = NULL WHERE ${MINE} RETURNING id`, [
      n.id,
      n.lock,
      rendered,
    ]);
    return rows.length ? "sent" : "lost";
  }

  const checks: { scope: "channel" | "agent"; key: string }[] = [
    { scope: "channel", key: "whatsapp_staff" },
    { scope: "agent", key: "manager" },
  ];
  if (n.template_key === "daily_report") checks.push({ scope: "channel", key: "report_delivery" });
  const sw = await isPaused(n.org_id, checks);
  if (sw.paused) return suppress(n, "paused", sw.reason);

  if (!template || template.status !== "approved") return suppress(n, "template_not_approved", template ? `Mẫu ${n.template_key} (${template.language}) đang ${template.status}` : `Chưa có mẫu ${n.template_key}`);
  const rendered = renderTemplate(template.body, n.payload);
  if (rendered.missing.length) return suppress(n, "template_missing_field", rendered.missing.join(", "));

  const phone = digits(user.phone ?? "").replace(/^00/, "");
  if (phone.length < 6) return suppress(n, "recipient_no_phone");

  const connector = await queryOne<{ id: string }>(
    "SELECT id FROM connector_accounts WHERE org_id = $1 AND channel = 'whatsapp' AND status IN ('active','testing') AND NOT paused ORDER BY status = 'active' DESC, created_at LIMIT 1",
    [n.org_id],
  );
  if (!connector) return suppress(n, "no_connector");

  // Chỉ tính tin vào ĐÚNG connector sẽ gửi, không tính hội thoại DEMO, và luôn so số của người nhận
  // (gắn staff_user_id mà từ số khác — ví dụ số cũ — thì không mở khoá).
  const inbound = await queryOne<{ id: string }>(
    `SELECT id FROM conversations
      WHERE org_id = $1 AND channel = 'whatsapp' AND connector_id = $2 AND NOT is_demo AND last_inbound_at IS NOT NULL
        AND (regexp_replace(coalesce(contact_handle, ''), '\\D', '', 'g') = $3
             OR (external_thread_id LIKE '%@s.whatsapp.net' AND regexp_replace(split_part(external_thread_id, '@', 1), '\\D', '', 'g') = $3))
      LIMIT 1`,
    [n.org_id, connector.id, phone],
  );
  if (!inbound) return suppress(n, "recipient_never_messaged");

  if (!isUrgent(n.payload)) {
    const recent = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM staff_notifications
        WHERE org_id = $1 AND recipient_user_id = $2 AND channel = 'whatsapp' AND id <> $3
          AND (sent_at > now() - make_interval(secs => $4) OR status = 'sending')`,
      [n.org_id, n.recipient_user_id, n.id, RATE_LIMIT_PER_RECIPIENT_MS / 1000],
    );
    if ((recent?.n ?? 0) > 0) return defer(n, RATE_LIMIT_PER_RECIPIENT_MS / 1000);
  }

  if (!transport) return fail(n, "Chưa có bộ gửi WhatsApp (transport) trong bản chạy này", rendered.text);

  // Compare-and-set ngay trước khi gọi mạng: tin vẫn do mình giữ thì làm mới khoá; không thì bỏ (tiến trình khác đã xử lý).
  const cas = await queryOne<{ lock: string }>(`UPDATE staff_notifications SET locked_at = now(), rendered_body = $3, connector_id = $4 WHERE ${MINE} RETURNING locked_at::text AS lock`, [
    n.id,
    n.lock,
    rendered.text,
    connector.id,
  ]);
  if (!cas) return "lost";
  n.lock = cas.lock;

  let result: Awaited<ReturnType<WhatsAppTransport>>;
  try {
    // Không đứng chờ lượt: giãn cách/trần của số tổng đài tính theo DB trong transport (dùng chung với hộp thư).
    result = await transport(n.org_id, connector.id, phone, rendered.text, { maxWaitMs: 0 });
  } catch (error) {
    result = { ok: false, reason: (error as Error).message ?? String(error) };
  }
  if (result.ok && result.externalId) {
    // Đã gửi thật thì ghi đúng sự thật, kể cả khi trạng thái vừa bị đổi dưới chân (không để đếm hạn mức thiếu).
    await query(
      "UPDATE staff_notifications SET status = 'sent', sent_at = now(), external_message_id = $2, rendered_body = $3, attempts = attempts + 1, error = NULL, locked_at = NULL WHERE id = $1",
      [n.id, result.externalId, rendered.text],
    );
    return "sent";
  }
  if (!result.ok && result.reason.startsWith("rate_limited")) {
    // Chắc chắn CHƯA gửi (chưa tới lượt / chạm trần của số tổng đài) ⇒ trả về hàng đợi.
    if (result.reason === "rate_limited_hour") {
      // Chạm trần theo giờ của số tổng đài: hẹn đúng lúc sớm nhất có lại chỗ (transport tính, dùng chung với hộp thư).
      const at = await nextHourSlotAt(n.org_id, connector.id).catch(() => null);
      return defer(n, at ?? 60);
    }
    return defer(n, 5);
  }
  // Lưu mã lỗi gốc (giao diện đổi sang chữ bằng sendFailureLabel). Lỗi không chắc chắn (hết giờ, 5xx) cũng không tự gửi lại.
  return fail(n, result.ok ? "no_message_id" : result.reason, rendered.text);
}

/** Giành đúng một tin đang chờ (đã tới lượt). */
async function claimOne(orgId?: string): Promise<QueuedRow | null> {
  return queryOne<QueuedRow>(
    `UPDATE staff_notifications SET status = 'sending', locked_at = now()
      WHERE id = (SELECT id FROM staff_notifications
                   WHERE status = 'queued' AND available_at <= now() ${orgId ? "AND org_id = $1" : ""}
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND status = 'queued'
      RETURNING id, org_id, recipient_user_id, channel, template_key, payload, locked_at::text AS lock`,
    orgId ? [orgId] : [],
  );
}

/**
 * Xử lý tối đa `limit` tin, giành từng tin một. `transport` tiêm vào để kiểm thử; mặc định `sendWhatsAppText` của hộp thư.
 */
export async function sendQueuedNotifications(opts: { transport?: WhatsAppTransport | null; limit?: number; orgId?: string } = {}) {
  const stats = { sent: 0, suppressed: 0, failed: 0, deferred: 0, lost: 0, stuck: 0 };
  const stuckParams: unknown[] = [SENDING_STUCK_SECONDS, [...heldByMe]];
  if (opts.orgId) stuckParams.push(opts.orgId);
  const stuck = await query<{ id: string }>(
    `UPDATE staff_notifications SET status = 'failed', error = 'Gián đoạn khi đang gửi — không rõ đã tới người nhận chưa, không tự gửi lại', locked_at = NULL
      WHERE status = 'sending' AND coalesce(locked_at, created_at) < now() - make_interval(secs => $1)
        AND NOT (id = ANY($2::uuid[])) ${opts.orgId ? "AND org_id = $3" : ""} RETURNING id`,
    stuckParams,
  );
  stats.stuck = stuck.length;

  const transport: WhatsAppTransport | null = opts.transport === undefined ? sendWhatsAppText : opts.transport;
  const limit = opts.limit ?? 50;
  const deferredIds = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const n = await claimOne(opts.orgId);
    if (!n) break;
    if (deferredIds.has(n.id)) {
      // Tin vừa hoãn lại tới lượt ngay trong lượt này: trả về hàng đợi, để lượt sau.
      await query("UPDATE staff_notifications SET status = 'queued', locked_at = NULL WHERE " + MINE, [n.id, n.lock]);
      break;
    }
    heldByMe.add(n.id);
    try {
      const outcome = await processOneNotification(n, transport);
      stats[outcome] += 1;
      if (outcome === "deferred") deferredIds.add(n.id);
    } catch (error) {
      stats[await fail(n, `Lỗi bộ gửi: ${(error as Error).message}`, null)] += 1;
    } finally {
      heldByMe.delete(n.id);
    }
  }
  return stats;
}
