import { query, queryOne } from "@/lib/db";
import { isPaused } from "@/modules/automation/switches";
import type { InboxDeps } from "./service";
import { UNCERTAIN_SEND_REASON, isUncertainSendFailure, sendWhatsAppText } from "./transport";

/**
 * Bộ gửi tin hộp thư — CHỈ worker chạy (jobs.ts). Web chỉ ghi 'queued'.
 *
 * Luồng: queued → (giành quyền nguyên tử) sending + locked_at + connector_id → sent | failed.
 * Không giữ giao dịch trong lúc gọi mạng (PGlite xếp hàng theo giao dịch).
 * Hạn mức 1 tin/3 giây mỗi connector: `reserveSendSlot` trong transport (theo DB, dùng chung với thông báo đội).
 * Lỗi không rõ kết quả (timeout, mất kết nối, 5xx, 2xx không mã tin) hoặc tin kẹt 'sending' ⇒ 'failed'
 * "không rõ đã gửi hay chưa", KHÔNG tự gửi lại.
 */

export const STUCK_AFTER_SECONDS = 120;
const MAX_PER_RUN = 20;

export type SendDeps = Pick<InboxDeps, "send">;

interface Claimed {
  id: string;
  org_id: string;
  body: string | null;
  author_type: string;
  connector_id: string | null;
  external_thread_id: string;
  kind: string;
  conversation_id: string;
}

/** Giành một tin bằng một câu lệnh (tự commit, trước khi gọi Evolution): queued → sending; tin đang bị khoá thì bỏ qua. */
async function claimNext(skipConnectors: string[]): Promise<Claimed | null> {
  return queryOne<Claimed>(
    `UPDATE messages m SET status = 'sending', locked_at = now(), connector_id = c.connector_id
       FROM conversations c
      WHERE m.id = (
              SELECT q.id FROM messages q JOIN conversations qc ON qc.id = q.conversation_id AND qc.org_id = q.org_id
               WHERE q.direction = 'out' AND q.status = 'queued'
                 AND (qc.connector_id IS NULL OR NOT (qc.connector_id = ANY($1::uuid[])))
               ORDER BY q.created_at
               LIMIT 1
               FOR UPDATE OF q SKIP LOCKED)
        AND m.status = 'queued' AND c.id = m.conversation_id AND c.org_id = m.org_id
     RETURNING m.id, m.org_id, m.body, m.author_type, c.connector_id, c.external_thread_id, c.kind, m.conversation_id`,
    [skipConnectors],
  );
}

async function finish(msg: Claimed, outcome: "sent" | "failed" | "release", detail: { externalId?: string; error?: string } = {}) {
  if (outcome === "release") {
    // Chắc chắn CHƯA gửi (chưa tới lượt) ⇒ trả tin về hàng đợi.
    await query("UPDATE messages SET status = 'queued', locked_at = NULL WHERE id = $1 AND status = 'sending'", [msg.id]);
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

export async function runSendQueue(deps: Partial<SendDeps> = {}): Promise<{ sent: number; failed: number; uncertain: number; deferred: number; recovered: number }> {
  const send = deps.send ?? sendWhatsAppText;
  const stats = { sent: 0, failed: 0, uncertain: 0, deferred: 0, recovered: await recoverStuckMessages() };
  const busyConnectors: string[] = [];
  for (let i = 0; i < MAX_PER_RUN; i++) {
    const msg = await claimNext(busyConnectors);
    if (!msg) break;
    if (!msg.connector_id) {
      await finish(msg, "failed", { error: "no_connector" });
      stats.failed++;
      continue;
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
    } else if (result.reason === "rate_limited") {
      await finish(msg, "release");
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
