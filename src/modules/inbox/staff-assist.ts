import { query, queryOne, withTx } from "@/lib/db";
import { formatDateVi, todayOps } from "@/lib/time";
import { AiError, aiConfigured, callTool, guestModel } from "@/modules/ai/claude";
import { redactForAi } from "@/modules/ai/redact";
import { isPaused } from "@/modules/automation/switches";

/**
 * Trợ lý trực nội bộ: tự trả lời tin của ĐỘI (hội thoại staff và nhóm) trên WhatsApp bằng Claude.
 *
 * Ranh giới an toàn:
 *   - CHỈ hội thoại kind 'staff' hoặc 'group'. Hội thoại khách (kind 'guest') không bao giờ do job này trả lời.
 *   - Chỉ chạy khi công tắc agent:staff_assist bật (mặc định tắt) và kênh whatsapp_staff không dừng.
 *   - Trợ lý chỉ ĐỌC số liệu rồi trả lời; không sửa booking, không đổi lịch, không gửi tin cho khách.
 *     Ai nhờ làm việc đó thì nó ghi nhận và nói sẽ chuyển cho người phụ trách.
 *   - Trong nhóm chỉ trả lời khi có người gọi tên (dương quá / trợ lý / bot / hệ thống), tránh nói chen.
 *   - Mỗi hội thoại tối đa 1 tin tự động trong 60 giây và không trả lời hai lần cho cùng một tin.
 *   - Tin ghi author_type 'system' (không phải 'bot'): luật "người tiếp quản thì bot im lặng" chỉ dành cho hội thoại khách.
 *   - Tin đội gửi được che số điện thoại/email trước khi đưa sang Claude.
 */

const MENTION = /(dương quá|duong qua|trợ lý|tro ly|hệ thống|he thong|\bbot\b)/i;
const REPLY_GAP_MS = 60_000;
const MAX_CONTEXT_MESSAGES = 8;

export interface StaffAssistResult extends Record<string, number> {
  checked: number;
  answered: number;
  skipped: number;
  failed: number;
}

interface Pending {
  conversationId: string;
  orgId: string;
  kind: "staff" | "group";
  title: string | null;
  contactName: string | null;
  lastInboundId: string;
  lastInboundBody: string | null;
  lastInboundAt: Date;
}

/** Hội thoại đội đang có tin chờ trả lời: tin vào mới nhất chưa có tin ra nào sau nó. */
async function pendingConversations(): Promise<Pending[]> {
  return query<Pending>(
    `SELECT c.id AS "conversationId", c.org_id AS "orgId", c.kind, c.title, c.contact_name AS "contactName",
            m.id AS "lastInboundId", m.body AS "lastInboundBody", m.created_at AS "lastInboundAt"
       FROM conversations c
       JOIN LATERAL (
         SELECT id, body, created_at FROM messages
          WHERE conversation_id = c.id AND direction = 'in'
          ORDER BY created_at DESC LIMIT 1
       ) m ON true
      WHERE c.kind IN ('staff','group')
        AND NOT EXISTS (
          SELECT 1 FROM messages o
           WHERE o.conversation_id = c.id AND o.direction = 'out' AND o.created_at > m.created_at
        )
        AND m.created_at > now() - interval '6 hours'
      ORDER BY m.created_at`,
  );
}

/** Số liệu vận hành hôm nay để trợ lý trả lời có căn cứ (không đưa tên khách ra ngoài). */
export async function opsSnapshot(orgId: string, tz = "Europe/Budapest") {
  const date = todayOps(tz);
  const row = await queryOne<{
    nha: number; san_pham: number; link_lich: number; dem_chan: number; booking: number;
    xung_dot: number; lech_lich: number; don_mo: number; don_qua_han: number; qa: number;
  }>(
    `SELECT (SELECT count(*)::int FROM properties WHERE org_id = $1) AS nha,
            (SELECT count(*)::int FROM units WHERE org_id = $1) AS san_pham,
            (SELECT count(*)::int FROM ical_feeds WHERE org_id = $1) AS link_lich,
            (SELECT count(*)::int FROM inventory_blocks WHERE org_id = $1 AND active) AS dem_chan,
            (SELECT count(*)::int FROM bookings WHERE org_id = $1 AND booking_status <> 'cancelled') AS booking,
            (SELECT count(*)::int FROM inventory_conflicts WHERE org_id = $1 AND status = 'open') AS xung_dot,
            (SELECT count(*)::int FROM calendar_sync_findings WHERE org_id = $1 AND status = 'open') AS lech_lich,
            (SELECT count(*)::int FROM cleaning_tasks WHERE org_id = $1 AND status NOT IN ('passed','cancelled')) AS don_mo,
            (SELECT count(*)::int FROM cleaning_tasks WHERE org_id = $1 AND status NOT IN ('passed','cancelled') AND due_at < now()) AS don_qua_han,
            (SELECT count(*)::int FROM qa_entries WHERE org_id = $1 AND status = 'approved') AS qa`,
    [orgId],
  );
  return { date, ...(row ?? { nha: 0, san_pham: 0, link_lich: 0, dem_chan: 0, booking: 0, xung_dot: 0, lech_lich: 0, don_mo: 0, don_qua_han: 0, qa: 0 }) };
}

const SYSTEM = `Bạn là "Dương Quá", trợ lý vận hành của Vietduc Hotel (căn hộ cho thuê ở Budapest). Bạn đang nhắn WhatsApp với NHÂN VIÊN trong công ty, không phải với khách.

Cách trả lời:
- Tiếng Việt, xưng "em", gọi người nhắn là "anh"/"chị"/tên họ. Ngắn gọn, tối đa 6 câu, không dùng markdown.
- Chỉ dùng số liệu trong phần "SỐ LIỆU HỆ THỐNG" được cung cấp. Không có số liệu thì nói thẳng là chưa có, KHÔNG đoán.
- Không bịa tên khách, mã đặt phòng, giá, mã cửa.
- Bạn chỉ ĐỌC được dữ liệu. Ai nhờ sửa booking, đổi lịch, giao việc, gửi tin cho khách: ghi nhận và nói sẽ chuyển cho người phụ trách (anh Hưng hoặc Thảo), đừng hứa là đã làm.
- Nếu câu hỏi cần thông tin đội chưa cung cấp (nội quy nhà, danh sách người dọn, link lịch Airbnb, file Excel booking), nói rõ đang thiếu gì và nhờ gửi.
- Không chào hỏi dài dòng, vào thẳng việc.`;

const TOOL = {
  name: "tra_loi",
  description: "Gửi câu trả lời cho nhân viên, hoặc bỏ qua nếu tin không cần trả lời.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["reply", "skip"], description: "reply = trả lời; skip = tin không cần trả lời (ví dụ chỉ là 'ok', 'cảm ơn')." },
      message: { type: "string", description: "Nội dung trả lời (khi action=reply)." },
      note: { type: "string", description: "Lý do ngắn (tiếng Việt)." },
    },
    required: ["action", "note"],
  },
};

interface ToolOut {
  action: "reply" | "skip";
  message?: string;
  note: string;
}

/** Một lượt: tìm hội thoại đội đang chờ, hỏi Claude, rồi xếp tin trả lời vào hàng đợi gửi. */
export async function runStaffAssist(): Promise<StaffAssistResult> {
  const out: StaffAssistResult = { checked: 0, answered: 0, skipped: 0, failed: 0 };
  if (!aiConfigured()) return out;
  const pendings = await pendingConversations();
  for (const p of pendings) {
    out.checked += 1;
    try {
      const sw = await isPaused(p.orgId, [{ scope: "agent", key: "staff_assist" }, { scope: "channel", key: "whatsapp_staff" }]);
      if (sw.paused) {
        out.skipped += 1;
        continue;
      }
      const text = (p.lastInboundBody ?? "").trim();
      if (!text) {
        out.skipped += 1;
        continue;
      }
      // Trong nhóm: chỉ lên tiếng khi được gọi tên.
      if (p.kind === "group" && !MENTION.test(text)) {
        out.skipped += 1;
        continue;
      }
      // Đã trả lời tin này rồi, hoặc vừa trả lời cách đây chưa tới 60 giây.
      const guard = await queryOne<{ answered: boolean; recent: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM agent_runs WHERE org_id = $1 AND agent_role = 'manager' AND task_key = $2) AS answered,
                EXISTS (SELECT 1 FROM messages WHERE conversation_id = $3 AND direction = 'out' AND created_at > now() - ($4 || ' milliseconds')::interval) AS recent`,
        [p.orgId, `staff_assist:${p.lastInboundId}`, p.conversationId, String(REPLY_GAP_MS)],
      );
      if (guard?.answered || guard?.recent) {
        out.skipped += 1;
        continue;
      }

      const history = await query<{ direction: string; author_name: string | null; body: string | null }>(
        `SELECT direction, author_name, body FROM messages
          WHERE conversation_id = $1 AND status <> 'discarded'
          ORDER BY created_at DESC LIMIT $2`,
        [p.conversationId, MAX_CONTEXT_MESSAGES],
      );
      const snapshot = await opsSnapshot(p.orgId);
      const conversation = history
        .reverse()
        .map((m) => `${m.direction === "in" ? (m.author_name ?? "Nhân viên") : "Dương Quá"}: ${redactForAi(m.body ?? "")}`)
        .join("\n");

      const user = `SỐ LIỆU HỆ THỐNG (ngày vận hành ${formatDateVi(snapshot.date)}, giờ Budapest):
- Nhà đang có trong hệ thống: ${snapshot.nha}; sản phẩm bán: ${snapshot.san_pham}; link lịch kênh: ${snapshot.link_lich}
- Số đêm đang bị chặn theo lịch kênh: ${snapshot.dem_chan}
- Booking chi tiết trong hệ thống: ${snapshot.booking} (lịch iCal chỉ cho biết đêm bận, không kèm tên khách; muốn đủ thì cần nhập file Excel hoặc nối API kênh)
- Xung đột lịch đang mở: ${snapshot.xung_dot}; lệch lịch với kênh: ${snapshot.lech_lich}
- Việc dọn đang mở: ${snapshot.don_mo}, trong đó quá hạn: ${snapshot.don_qua_han}
- Câu trả lời khách đã duyệt trong kho Q&A: ${snapshot.qa}
- Đang chờ đội gửi: link lịch Airbnb từng phòng, file Excel lịch đặt phòng, nội quy nhà, danh sách người dọn, checklist dọn phòng.
- Địa chỉ hệ thống: https://vietduc-hub.com

HỘI THOẠI (${p.kind === "group" ? `nhóm ${p.title ?? ""}` : `nhắn riêng với ${p.contactName ?? "nhân viên"}`}):
${conversation}

Trả lời tin cuối cùng của nhân viên.`;

      const model = guestModel();
      const run = await queryOne<{ id: string }>(
        `INSERT INTO agent_runs (org_id, agent_role, task_key, entity_type, entity_id, tools_allowed, status, attempt, started_at, heartbeat_at, input)
         VALUES ($1,'manager',$2,'message',$3,'{tra_loi}','running',1,now(),now(),$4)
         ON CONFLICT (org_id, agent_role, task_key) DO NOTHING RETURNING id`,
        [p.orgId, `staff_assist:${p.lastInboundId}`, p.lastInboundId, JSON.stringify({ model, conversationId: p.conversationId, kind: p.kind })],
      );
      if (!run) {
        out.skipped += 1;
        continue;
      }

      let res: Awaited<ReturnType<typeof callTool<ToolOut>>>;
      try {
        res = await callTool<ToolOut>({ system: SYSTEM, user, tool: TOOL, model, maxTokens: 700 });
      } catch (error) {
        const e = error as AiError;
        await query("UPDATE agent_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1", [run.id, e?.code === "timeout" ? "timed_out" : "failed", e?.message ?? "loi AI"]);
        out.failed += 1;
        continue;
      }

      const usage = { model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: Number(res.costUsd.toFixed(6)) };
      const body = String(res.input.message ?? "").trim();
      if (res.input.action !== "reply" || !body) {
        await query("UPDATE agent_runs SET status = 'succeeded', output = $2, cost_minor = $3, finished_at = now() WHERE id = $1", [
          run.id,
          JSON.stringify({ ...usage, action: "skip", note: res.input.note }),
          Math.ceil(res.costUsd * 100),
        ]);
        out.skipped += 1;
        continue;
      }

      await withTx(async (tx) => {
        await tx.query(
          `INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status, queued_at)
           VALUES ($1,$2,'out','system','Dương Quá — trợ lý',$3,'queued',now())`,
          [p.orgId, p.conversationId, body.slice(0, 3000)],
        );
        await tx.query("UPDATE conversations SET last_message_at = now(), unread_count = 0, updated_at = now() WHERE id = $1", [p.conversationId]);
      });
      await query("UPDATE agent_runs SET status = 'succeeded', output = $2, cost_minor = $3, finished_at = now() WHERE id = $1", [
        run.id,
        JSON.stringify({ ...usage, action: "reply", note: res.input.note, length: body.length }),
        Math.ceil(res.costUsd * 100),
      ]);
      out.answered += 1;
    } catch (error) {
      console.error("[staff-assist] lỗi hội thoại", p.conversationId, (error as Error)?.message);
      out.failed += 1;
    }
  }
  return out;
}
