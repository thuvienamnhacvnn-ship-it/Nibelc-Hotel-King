import { pool, query, queryOne } from "@/lib/db";
import { isPaused } from "@/modules/automation/switches";
import { SEND_LIMITS } from "./limits";
import { type InboxDeps, botConversationLimitHit, discardBotMessageForLimit } from "./service";
import { UNCERTAIN_SEND_REASON, isUncertainSendFailure, nextHourSlotAt, sendWhatsAppText } from "./transport";

/**
 * Bộ gửi tin hộp thư — CHỈ worker chạy (jobs.ts). Web chỉ ghi 'queued'.
 *
 * Luồng: queued → (giành quyền nguyên tử) sending → sent | failed | discarded | về queued (chưa tới lượt).
 * Không giữ giao dịch trong lúc gọi mạng (PGlite xếp hàng theo giao dịch).
 * `queued_at` = lúc vào hàng đợi (tính hạn gửi, không đổi khi chờ lượt); `locked_at` = lúc giành quyền gửi (chỉ đặt khi 'sending',
 * tin 'queued' luôn NULL); `available_at` = hoãn tới khi có lượt.
 * Mọi trần số lượng ở `limits.ts`; trần theo connector (3 giây, 30/giờ) nằm trong `reserveSendSlot` của transport.
 * Lỗi không rõ kết quả hoặc tin kẹt ⇒ 'failed' "không rõ đã gửi hay chưa", KHÔNG tự gửi lại.
 */

export const STUCK_AFTER_SECONDS = SEND_LIMITS.stuckSendingMs / 1000;
const MAX_PER_RUN = 20;

export type SendDeps = Pick<InboxDeps, "send">;

interface Claimed {
  id: string;
  org_id: string;
  body: string | null;
  author_type: string;
  approved_by: string | null;
  connector_id: string | null;
  external_thread_id: string;
  kind: string;
  conversation_id: string;
}

/** Tin bot tự gửi (chưa ai duyệt) dùng hạn ngắn; tin người viết/duyệt dùng hạn dài. */
const expirySql = (a: string) =>
  `coalesce(${a}.queued_at, ${a}.created_at) < now() - make_interval(secs => CASE WHEN ${a}.author_type = 'bot' AND ${a}.approved_by IS NULL THEN $1::int ELSE $2::int END)`;
const EXPIRY_PARAMS = [SEND_LIMITS.botQueueTtlMs / 1000, SEND_LIMITS.staffQueueTtlMs / 1000];

/** Tin 'queued' quá hạn ⇒ failed "quá hạn gửi — xem lại trước khi gửi lại", không gửi. */
export async function expireQueuedMessages(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE messages m SET status = 'failed', error = 'expired' WHERE m.direction = 'out' AND m.status = 'queued' AND ${expirySql("m")} RETURNING m.id`,
    EXPIRY_PARAMS,
  );
  return rows.length;
}

/** Giành một tin bằng một câu lệnh (tự commit, trước khi gọi Evolution): queued → sending; tin đang bị khoá thì bỏ qua. */
async function claimNext(skipConnectors: string[]): Promise<Claimed | null> {
  return queryOne<Claimed>(
    `WITH next AS (
       SELECT q.id FROM messages q JOIN conversations qc ON qc.id = q.conversation_id AND qc.org_id = q.org_id
        WHERE q.direction = 'out' AND q.status = 'queued'
          AND (q.available_at IS NULL OR q.available_at <= now())
          AND (qc.connector_id IS NULL OR NOT (qc.connector_id = ANY($3::uuid[])))
          AND NOT (${expirySql("q")})
        ORDER BY q.created_at
        LIMIT 1
        FOR UPDATE OF q SKIP LOCKED)
     UPDATE messages m SET status = 'sending', locked_at = now(), connector_id = c.connector_id
       FROM next, conversations c
      WHERE m.id = next.id AND m.status = 'queued' AND c.id = m.conversation_id AND c.org_id = m.org_id
     RETURNING m.id, m.org_id, m.body, m.author_type, m.approved_by, c.connector_id, c.external_thread_id, c.kind, m.conversation_id`,
    [...EXPIRY_PARAMS, skipConnectors],
  );
}

async function finish(msg: Claimed, outcome: "sent" | "failed" | "release", detail: { externalId?: string; error?: string; availableAt?: Date | null } = {}) {
  if (outcome === "release") {
    // Chắc chắn CHƯA gửi (chưa tới lượt) ⇒ trả về hàng đợi; queued_at giữ nguyên nên hạn gửi không bị kéo dài;
    // vượt trần giờ thì hoãn tới lúc có lượt (available_at). Hoãn quá hạn gửi ⇒ vòng sau đánh expired.
    await query("UPDATE messages SET status = 'queued', locked_at = NULL, available_at = $2 WHERE id = $1 AND status = 'sending'", [msg.id, detail.availableAt ?? null]);
    return;
  }
  if (outcome === "sent") {
    const clash = await queryOne("SELECT 1 FROM messages WHERE conversation_id = $1 AND external_message_id = $2 AND id <> $3", [msg.conversation_id, detail.externalId, msg.id]);
    await query("UPDATE messages SET status = 'sent', sent_at = now(), external_message_id = $2, error = NULL WHERE id = $1 AND status = 'sending'", [
      msg.id,
      clash ? null : detail.externalId,
    ]);
    return;
  }
  await query("UPDATE messages SET status = 'failed', error = $2 WHERE id = $1 AND status = 'sending'", [msg.id, (detail.error ?? "unknown").slice(0, 500)]);
}

/** Tin kẹt 'sending' quá lâu (tiến trình chết giữa chừng) ⇒ failed "không rõ" để người kiểm trên điện thoại rồi mới gửi lại. */
export async function recoverStuckMessages(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE messages SET status = 'failed', error = $1
      WHERE direction = 'out' AND status = 'sending' AND coalesce(locked_at, created_at) < now() - make_interval(secs => $2)
      RETURNING id`,
    [`${UNCERTAIN_SEND_REASON}: tiến trình gửi dừng giữa chừng`, STUCK_AFTER_SECONDS],
  );
  return rows.length;
}

export async function runSendQueue(
  deps: Partial<SendDeps> = {},
): Promise<{ sent: number; failed: number; uncertain: number; deferred: number; recovered: number; expired: number; discarded: number }> {
  const send = deps.send ?? sendWhatsAppText;
  const stats = { sent: 0, failed: 0, uncertain: 0, deferred: 0, recovered: await recoverStuckMessages(), expired: await expireQueuedMessages(), discarded: 0 };
  const busyConnectors: string[] = [];
  for (let i = 0; i < MAX_PER_RUN; i++) {
    const msg = await claimNext(busyConnectors);
    if (!msg) break;
    if (!msg.connector_id) {
      await finish(msg, "failed", { error: "no_connector" });
      stats.failed++;
      continue;
    }
    if (msg.author_type === "bot") {
      // Kiểm lại ngay trước khi gửi: người đã tiếp quản ⇒ bot im lặng.
      const taken = await queryOne(
        `UPDATE messages m SET status = 'discarded', error = 'taken_over' FROM conversations c
          WHERE m.id = $1 AND m.status = 'sending' AND c.id = m.conversation_id AND c.org_id = m.org_id AND c.handled_by <> 'bot' RETURNING m.id`,
        [msg.id],
      );
      if (taken) {
        stats.discarded++;
        continue;
      }
      if (!msg.approved_by && (await botConversationLimitHit(pool(), msg.org_id, msg.conversation_id, msg.id))) {
        await discardBotMessageForLimit(msg.org_id, msg.conversation_id, msg.id);
        stats.discarded++;
        continue;
      }
    }
    const channelKey = msg.kind === "guest" || msg.kind === "unknown" ? "whatsapp_guest" : "whatsapp_staff";
    const checks = msg.author_type === "bot" ? [{ scope: "agent" as const, key: "guest" }, { scope: "channel" as const, key: channelKey }] : [{ scope: "channel" as const, key: channelKey }];
    const paused = await isPaused(msg.org_id, checks);
    if (paused.paused) {
      await finish(msg, "failed", { error: `switch_paused: ${paused.reason ?? ""}` });
      stats.failed++;
      continue;
    }
    let result;
    try {
      result = await send(msg.org_id, msg.connector_id, msg.external_thread_id, msg.body ?? "", { maxWaitMs: 0 });
    } catch {
      result = { ok: false as const, reason: "network_error" };
    }
    if (result.ok) {
      await finish(msg, "sent", { externalId: result.externalId });
      stats.sent++;
    } else if (result.reason.startsWith("rate_limited")) {
      // 3 giây hoặc trần giờ của connector: chắc chắn chưa gửi ⇒ chờ lượt sau (hạn gửi vẫn tính từ lúc xếp hàng).
      const availableAt = result.reason === "rate_limited_hour" ? await nextHourSlotAt(msg.org_id, msg.connector_id) : null;
      await finish(msg, "release", { availableAt });
      busyConnectors.push(msg.connector_id);
      stats.deferred++;
    } else if (isUncertainSendFailure(result.reason)) {
      await finish(msg, "failed", { error: `${UNCERTAIN_SEND_REASON}: ${result.reason}` });
      stats.uncertain++;
    } else {
      await finish(msg, "failed", { error: result.reason });
      stats.failed++;
    }
  }
  return stats;
}
