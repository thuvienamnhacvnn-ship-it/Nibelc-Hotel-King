import { query, queryOne, withTx } from "@/lib/db";
import { formatDateVi, todayOps } from "@/lib/time";
import { AiError, aiConfigured, callTool, guestModel } from "@/modules/ai/claude";
import { redactForAi } from "@/modules/ai/redact";
import { isPaused } from "@/modules/automation/switches";
import { ROLE_LABELS, type Role } from "@/modules/auth/permissions";

/**
 * Trợ lý trực nội bộ: tự trả lời tin của ĐỘI (hội thoại staff và nhóm) trên WhatsApp bằng Claude.
 *
 * Ranh giới an toàn:
 *   - CHỈ hội thoại kind 'staff' hoặc 'group'. Hội thoại khách (kind 'guest') không bao giờ do job này trả lời.
 *   - Chỉ chạy khi công tắc agent:staff_assist bật (mặc định tắt) và kênh whatsapp_staff không dừng.
 *   - Trợ lý chỉ ĐỌC số liệu rồi trả lời; không sửa booking, không đổi lịch, không gửi tin cho khách.
 *     Ai nhờ làm việc đó thì nó ghi nhận và nói sẽ chuyển cho người phụ trách.
 *   - Trong nhóm chỉ trả lời khi có người gọi: gọi tên (dương quá / trợ lý / bot / hệ thống) HOẶC bấm @
 *     đúng số của tổng đài — tránh nói chen. WhatsApp gửi lời gọi @ dưới dạng số, không phải tên.
 *   - Mỗi hội thoại tối đa 1 tin tự động trong 60 giây và không trả lời hai lần cho cùng một tin.
 *   - Tin ghi author_type 'system' (không phải 'bot'): luật "người tiếp quản thì bot im lặng" chỉ dành cho hội thoại khách.
 *   - Tin đội gửi được che số điện thoại/email trước khi đưa sang Claude.
 */

const MENTION = /(dương quá|duong qua|trợ lý|tro ly|hệ thống|he thong|\bbot\b)/i;
const REPLY_GAP_MS = 60_000;
const MAX_CONTEXT_MESSAGES = 8;
/** Nhìn lại bao xa. Để rộng để tin gửi lúc đêm vẫn được trả lời khi worker vừa khởi động lại. */
const LOOKBACK_HOURS = 48;

/**
 * Số WhatsApp của chính tổng đài, để biết lúc nào nhóm đang gọi mình.
 * Trong nhóm không ai gõ tên — họ bấm @ rồi chọn danh bạ, WhatsApp gửi đi dưới dạng "@<số>",
 * và số đó có thể là LID (số ẩn danh nội bộ) chứ không phải số điện thoại. Khai cả hai trong env,
 * ngăn cách bằng dấu phẩy: WHATSAPP_SELF_MENTIONS=36704092957,58579830710497
 */
function selfHandles(): string[] {
  return (process.env.WHATSAPP_SELF_MENTIONS ?? "")
    .split(",")
    .map((s) => s.replace(/[^0-9]/g, ""))
    .filter((s) => s.length >= 8);
}

/** Tin này có đang gọi trợ lý không: gọi tên, hoặc @ đúng số của tổng đài. */
export function addressedToAssistant(text: string): boolean {
  if (MENTION.test(text)) return true;
  const ids = selfHandles();
  if (ids.length === 0) return false;
  const mentioned = text.match(/@([0-9]{8,})/g)?.map((m) => m.slice(1)) ?? [];
  return mentioned.some((m) => ids.includes(m));
}

export interface StaffAssistResult extends Record<string, number> {
  checked: number;
  answered: number;
  skipped: number;
  failed: number;
  /** Số lần trợ lý được nhờ báo lên nhóm và đã đăng thật. */
  postedToGroup: number;
}

interface Attachment {
  kind: string;
  error?: string;
  duplicateOf?: { at: string; from: string | null };
}

interface InboundMsg {
  id: string;
  body: string | null;
  createdAt: Date;
  attachments: Attachment[];
}

/** Mô tả tệp cho trợ lý biết đường trả lời: nhận được chưa, hỏng gì, có phải gửi lại đồ cũ không. */
function describeAttachments(atts: Attachment[]): string {
  if (!atts.length) return "";
  const parts = atts.map((a) => {
    const ten = a.kind === "image" ? "ảnh" : a.kind === "video" ? "clip" : a.kind === "document" ? "tệp" : a.kind;
    if (a.error) return `${ten} (CHƯA lấy được nội dung: ${a.error})`;
    if (a.duplicateOf) return `${ten} (TRÙNG với tệp đã gửi lúc ${a.duplicateOf.at}${a.duplicateOf.from ? ` bởi ${a.duplicateOf.from}` : ""})`;
    return `${ten} (đã nhận và lưu xong)`;
  });
  return `[gửi kèm: ${parts.join(", ")}]`;
}

interface Pending {
  conversationId: string;
  orgId: string;
  kind: "staff" | "group";
  title: string | null;
  contactName: string | null;
  /** Các tin vào chưa được trả lời, cũ trước mới sau. */
  inbound: InboundMsg[];
}

/**
 * Hội thoại đội đang có tin chờ trả lời: mọi tin vào kể từ tin ra gần nhất.
 * Lấy cả loạt chứ không chỉ tin cuối, vì trong nhóm người ta hay gọi trợ lý rồi nhắn tiếp
 * vài câu với nhau — chỉ nhìn tin cuối thì lời gọi bị trôi mất và trợ lý im luôn.
 */
async function pendingConversations(): Promise<Pending[]> {
  const rows = await query<{
    conversationId: string; orgId: string; kind: "staff" | "group";
    title: string | null; contactName: string | null;
    id: string; body: string | null; createdAt: Date; attachments: Attachment[];
  }>(
    `SELECT c.id AS "conversationId", c.org_id AS "orgId", c.kind, c.title, c.contact_name AS "contactName",
            m.id, m.body, m.created_at AS "createdAt", m.attachments
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id AND m.direction = 'in'
      WHERE c.kind IN ('staff','group')
        AND m.created_at > now() - ($1 || ' hours')::interval
        AND m.created_at > COALESCE(
              (SELECT max(o.created_at) FROM messages o WHERE o.conversation_id = c.id AND o.direction = 'out'),
              to_timestamp(0))
      ORDER BY c.id, m.created_at`,
    [String(LOOKBACK_HOURS)],
  );
  const byConv = new Map<string, Pending>();
  for (const r of rows) {
    let p = byConv.get(r.conversationId);
    if (!p) {
      p = { conversationId: r.conversationId, orgId: r.orgId, kind: r.kind, title: r.title, contactName: r.contactName, inbound: [] };
      byConv.set(r.conversationId, p);
    }
    p.inbound.push({ id: r.id, body: r.body, createdAt: r.createdAt, attachments: r.attachments ?? [] });
  }
  return [...byConv.values()];
}

/** Số liệu vận hành hôm nay để trợ lý trả lời có căn cứ (không đưa tên khách ra ngoài). */
export async function opsSnapshot(orgId: string, tz = "Europe/Budapest") {
  const date = todayOps(tz);
  const row = await queryOne<{
    nha: number; san_pham: number; link_lich: number; dem_chan: number; booking: number;
    xung_dot: number; lech_lich: number; don_mo: number; don_qua_han: number; qa: number;
    nguoi_don: number; mau_checklist: number; lan_nhap: number; suc_chua_tam: number;
    truc_su_co: number; nhan_bao_cao: number;
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
            (SELECT count(*)::int FROM qa_entries WHERE org_id = $1 AND status = 'approved') AS qa,
            (SELECT count(*)::int FROM cleaner_profiles WHERE org_id = $1) AS nguoi_don,
            (SELECT count(*)::int FROM checklist_templates WHERE org_id = $1) AS mau_checklist,
            (SELECT count(*)::int FROM import_batches WHERE org_id = $1) AS lan_nhap,
            (SELECT count(*)::int FROM units WHERE org_id = $1 AND kind <> 'whole' AND capacity = 2) AS suc_chua_tam,
            (SELECT count(*)::int FROM escalation_contacts WHERE org_id = $1) AS truc_su_co,
            (SELECT count(*)::int FROM report_subscriptions WHERE org_id = $1) AS nhan_bao_cao`,
    [orgId],
  );
  return {
    date,
    ...(row ?? {
      nha: 0, san_pham: 0, link_lich: 0, dem_chan: 0, booking: 0, xung_dot: 0, lech_lich: 0, don_mo: 0, don_qua_han: 0, qa: 0,
      nguoi_don: 0, mau_checklist: 0, lan_nhap: 0, suc_chua_tam: 0, truc_su_co: 0, nhan_bao_cao: 0,
    }),
  };
}

/**
 * Đội hình: ai giữ vai gì. Không có cái này thì trợ lý đoán theo tên nghe thấy trong chat và
 * dồn hết việc lên người nhắn nhiều nhất (đã dính 26/09: giao việc sức chứa cho Sếp Hưng
 * trong khi đó là việc của quản trị hệ thống).
 */
export async function teamRoster(orgId: string) {
  const rows = await query<{ full_name: string; role: Role }>(
    "SELECT full_name, role FROM users WHERE org_id = $1 AND active AND role <> 'cleaner' ORDER BY full_name",
    [orgId],
  );
  return rows.map((r) => `${r.full_name} — ${ROLE_LABELS[r.role] ?? r.role}`);
}

/**
 * Việc còn thiếu, SUY TỪ DỮ LIỆU chứ không viết cứng trong lời dặn.
 * Viết cứng thì sửa xong vẫn còn đòi (đã dính: link Airbnb đã nối đủ mà trợ lý vẫn đi giục).
 */
export function missingItems(s: Awaited<ReturnType<typeof opsSnapshot>>): string[] {
  const out: string[] = [];
  if (s.suc_chua_tam > 0) out.push(`sức chứa thật của ${s.suc_chua_tam} phòng (đang tạm để 2 khách/phòng)`);
  if (s.lan_nhap === 0) out.push("file Excel lịch đặt phòng (hiện chưa nhập lần nào nên hệ thống không có tên khách, không có tiền)");
  if (s.nguoi_don === 0) out.push("danh sách người dọn kèm ca làm");
  if (s.mau_checklist === 0) out.push("checklist dọn phòng và mục nào bắt buộc chụp ảnh");
  if (s.qa < 10) out.push(`nội quy nhà và câu hỏi khách hay hỏi (kho Q&A mới có ${s.qa} câu đã duyệt)`);
  if (s.truc_su_co === 0) out.push("ai trực nhận sự cố gấp và ai trực thay");
  if (s.nhan_bao_cao === 0) out.push("ai nhận báo cáo đầu ngày / cuối ngày và mấy giờ");
  return out;
}

const SYSTEM = `Bạn là "Dương Quá", trợ lý vận hành của Vietduc Hotel (căn hộ cho thuê ở Budapest). Bạn đang nhắn WhatsApp với NHÂN VIÊN trong công ty, không phải với khách.

Cách trả lời:
- Tiếng Việt, xưng "em", gọi người nhắn là "anh"/"chị"/tên họ. Ngắn gọn, tối đa 6 câu, không dùng markdown.
- Chỉ dùng số liệu trong phần "SỐ LIỆU HỆ THỐNG" được cung cấp. Không có số liệu thì nói thẳng là chưa có, KHÔNG đoán.
- Không bịa tên khách, mã đặt phòng, giá, mã cửa.
- Tuyệt đối không nhắc lại mật khẩu, tài khoản đăng nhập hay mã cửa mà đồng đội gửi trong nhóm.
- Bạn chỉ ĐỌC được dữ liệu. Ai nhờ sửa booking, đổi lịch, giao việc, gửi tin cho khách: ghi nhận và nói sẽ chuyển cho người phụ trách (anh Hưng hoặc Thảo), đừng hứa là đã làm.
- Việc DUY NHẤT bạn tự làm được ngoài trả lời: đăng một tin lên nhóm vận hành, bằng cách điền group_message. Ai nhắn riêng nhờ "báo lên nhóm", "nhắc nhóm", "giục mọi người" thì PHẢI điền group_message ngay lượt này — nói suông là hứa mà không làm. Tin lên nhóm phải nêu rõ cần gì và ai phải làm, dựa vào phần "Đang còn thiếu" trong số liệu.
- Không bao giờ nói "em đã làm X" nếu X không nằm trong những thứ bạn vừa thực sự làm ở lượt này.
- Nếu câu hỏi cần thông tin đội chưa cung cấp (nội quy nhà, danh sách người dọn, link lịch Airbnb, file Excel booking), nói rõ đang thiếu gì và nhờ gửi.
- Không chào hỏi dài dòng, vào thẳng việc.
- Ai gửi ảnh, clip hay tệp thì LUÔN cảm ơn và nói rõ đã nhận được chưa. Phần "[gửi kèm: ...]" là ghi chú của hệ thống, không phải lời người gửi: nội dung lấy được thì báo đã nhận xong; chưa lấy được thì xin lỗi, nói là lỗi bên mình và đang sửa, đừng bắt người ta gửi lại nếu chưa sửa xong.
- Tệp bị đánh dấu TRÙNG với tệp gửi trước đó: nói thẳng nhưng nhẹ nhàng, hỏi lại cho rõ, không kết tội ai.
- Khi nêu ai phải làm việc gì: chỉ dựa vào phần ĐỘI HÌNH. Không có người rõ ràng cho một việc thì ghi "chưa rõ ai phụ trách, nhờ chị quản trị hệ thống phân công" — TUYỆT ĐỐI không đoán theo tên nghe thấy trong hội thoại và không dồn việc cho người đang nhắn.`;

const TOOL = {
  name: "tra_loi",
  description: "Gửi câu trả lời cho nhân viên, hoặc bỏ qua nếu tin không cần trả lời.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["reply", "skip"], description: "reply = trả lời; skip = tin không cần trả lời (ví dụ chỉ là 'ok', 'cảm ơn')." },
      message: { type: "string", description: "Nội dung trả lời cho người đang nhắn. LUÔN phải có khi action=reply, kể cả khi đã điền group_message." },
      group_message: {
        type: "string",
        description:
          "Nội dung đăng lên nhóm vận hành. CHỈ dùng khi người đang nhắn riêng yêu cầu báo/nhắc/giục lên nhóm. Không yêu cầu thì bỏ trống.",
      },
      note: { type: "string", description: "Lý do ngắn (tiếng Việt)." },
    },
    required: ["action", "note"],
  },
};

interface ToolOut {
  action: "reply" | "skip";
  message?: string;
  group_message?: string;
  note: string;
}

/** Hội thoại nhóm vận hành của tổ chức (nhóm hoạt động gần nhất nếu có nhiều nhóm). */
async function opsGroupConversation(orgId: string) {
  return queryOne<{ id: string }>(
    "SELECT id FROM conversations WHERE org_id = $1 AND kind = 'group' ORDER BY last_message_at DESC NULLS LAST LIMIT 1",
    [orgId],
  );
}

/**
 * Lời nhắc gửi sang Claude. Dùng CHUNG cho worker và cho `askAssistantOnce`, để hỏi thử cũng
 * đúng y như lúc chạy thật — hai bản lời nhắc khác nhau thì thử xong vẫn không biết thật ra sao.
 *
 * Hội thoại TRƯỚC, số liệu SAU: số cũ nằm trong hội thoại, đặt số mới ở cuối để nó không nhặt lại số cũ.
 * (Đã dính 26/09: báo "79 đêm chặn" trong khi hệ thống có 442 — số 79 là của báo cáo mấy ngày trước.)
 */
export function buildAssistPrompt(input: {
  where: string;
  conversation: string;
  snapshot: Awaited<ReturnType<typeof opsSnapshot>>;
  roster?: string[];
}) {
  const { where, conversation, snapshot, roster = [] } = input;
  const missing = missingItems(snapshot);
  return `HỘI THOẠI (${where}):
${conversation}

SỐ LIỆU HỆ THỐNG — ĐỌC LÚC NÀY, ngày vận hành ${formatDateVi(snapshot.date)}, giờ Budapest:
- Nhà đang có trong hệ thống: ${snapshot.nha}; sản phẩm bán: ${snapshot.san_pham}; link lịch kênh: ${snapshot.link_lich}
- Số đêm đang bị chặn theo lịch kênh: ${snapshot.dem_chan}
- Booking chi tiết trong hệ thống: ${snapshot.booking} (lịch iCal chỉ cho biết đêm bận, không kèm tên khách; muốn đủ thì cần nhập file Excel hoặc nối API kênh)
- Xung đột lịch đang mở: ${snapshot.xung_dot}; lệch lịch với kênh: ${snapshot.lech_lich}
- Việc dọn đang mở: ${snapshot.don_mo}, trong đó quá hạn: ${snapshot.don_qua_han}
- Câu trả lời khách đã duyệt trong kho Q&A: ${snapshot.qa}
- Địa chỉ hệ thống: https://vietduc-hub.com
${missing.length ? `- Đang còn thiếu: ${missing.join("; ")}.` : "- Không còn thiếu dữ liệu nền nào."}
${roster.length ? `
ĐỘI HÌNH (ai giữ vai gì — chỉ giao việc theo danh sách này, không đoán):
${roster.map((r) => `- ${r}`).join("\n")}` : ""}

BẮT BUỘC: mọi con số trong câu trả lời phải lấy từ khối SỐ LIỆU HỆ THỐNG ngay trên. Con số xuất hiện trong phần HỘI THOẠI là của những ngày trước, ĐÃ CŨ, không được dùng lại.

Trả lời tin cuối cùng của nhân viên.`;
}

/**
 * Câu hứa sẽ báo lên nhóm. Model rất hay nói "em sẽ báo lên nhóm" rồi bỏ trống group_message —
 * hứa ở tương lai để khỏi làm ngay. Lời dặn không chặn được nên phải bắt ở đây.
 */
const HUA_BAO_NHOM = /(báo|đăng|nhắc|giục|thông báo|gửi)[^.]{0,40}(lên|vào|trong)\s+(nhóm|group)/i;

/** Có hứa mà không làm không: cần gọi lại một lần với lệnh dứt khoát. */
export function loiHuaChuaLam(reply: string, groupMessage: string): boolean {
  return HUA_BAO_NHOM.test(reply) && groupMessage.trim().length === 0;
}

const LENH_LAM_NGAY = `
LỖI Ở LƯỢT TRƯỚC: bạn nói sẽ báo lên nhóm nhưng để trống group_message, tức là hứa mà không làm.
Lần này BẮT BUỘC điền group_message với nội dung đầy đủ cần đăng lên nhóm, và trong message chỉ nói
là đã báo (đã làm rồi), không nói "sẽ".`;

/** Đăng một tin lên nhóm vận hành dưới tên trợ lý; worker gửi ở vòng kế tiếp. */
export async function postToOpsGroup(orgId: string, body: string) {
  const text = body.trim();
  if (!text) return { posted: false as const, reason: "tin rong" };
  const group = await opsGroupConversation(orgId);
  if (!group) return { posted: false as const, reason: "chua co hoi thoai nhom" };
  await withTx(async (tx) => {
    await tx.query(
      `INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status, queued_at)
       VALUES ($1,$2,'out','system','Dương Quá — trợ lý',$3,'queued',now())`,
      [orgId, group.id, text.slice(0, 3000)],
    );
    await tx.query("UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1", [group.id]);
  });
  return { posted: true as const, conversationId: group.id };
}

/**
 * Hỏi trợ lý một câu và lấy ngay câu trả lời, KHÔNG ghi tin, KHÔNG gửi WhatsApp cho ai.
 * Để Sếp và đội thử trực tiếp mà không làm ồn hộp thư của người khác.
 */
export async function askAssistantOnce(orgId: string, question: string, asName = "Sếp Hưng") {
  const snapshot = await opsSnapshot(orgId);
  const user = buildAssistPrompt({
    where: `nhắn riêng với ${asName}`,
    conversation: `${asName}: ${redactForAi(question)}`,
    snapshot,
    roster: await teamRoster(orgId),
  });
  let res = await callTool<ToolOut>({ system: SYSTEM, user, tool: TOOL, model: guestModel(), maxTokens: 700 });
  if (loiHuaChuaLam(String(res.input.message ?? ""), String(res.input.group_message ?? ""))) {
    res = await callTool<ToolOut>({ system: SYSTEM, user: `${user}
${LENH_LAM_NGAY}`, tool: TOOL, model: guestModel(), maxTokens: 700 });
  }
  return {
    reply: String(res.input.message ?? "").trim(),
    groupMessage: String(res.input.group_message ?? "").trim(),
    note: res.input.note,
    model: res.model,
    costUsd: Number(res.costUsd.toFixed(6)),
    snapshot,
  };
}

/** Một lượt: tìm hội thoại đội đang chờ, hỏi Claude, rồi xếp tin trả lời vào hàng đợi gửi. */
export async function runStaffAssist(): Promise<StaffAssistResult> {
  const out: StaffAssistResult = { checked: 0, answered: 0, skipped: 0, failed: 0, postedToGroup: 0 };
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
      // Tin chỉ có ảnh, không kèm chữ, vẫn là tin cần trả lời: người ta gửi cho mình thì phải
      // cảm ơn và báo đã nhận được hay chưa, im lặng là thất lễ.
      const said = p.inbound.filter((m) => (m.body ?? "").trim().length > 0 || m.attachments.length > 0);
      const target =
        p.kind === "group"
          ? [...said].reverse().find((m) => addressedToAssistant((m.body ?? "").trim()) || m.attachments.length > 0)
          : said[said.length - 1];
      if (!target) {
        out.skipped += 1;
        continue;
      }
      const text = [(target.body ?? "").trim(), describeAttachments(target.attachments)].filter(Boolean).join(" ").trim();
      // Đã trả lời tin này rồi, hoặc vừa trả lời cách đây chưa tới 60 giây.
      const guard = await queryOne<{ answered: boolean; recent: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM agent_runs WHERE org_id = $1 AND agent_role = 'manager' AND task_key = $2) AS answered,
                EXISTS (SELECT 1 FROM messages WHERE conversation_id = $3 AND direction = 'out' AND created_at > now() - ($4 || ' milliseconds')::interval) AS recent`,
        [p.orgId, `staff_assist:${target.id}`, p.conversationId, String(REPLY_GAP_MS)],
      );
      if (guard?.answered || guard?.recent) {
        out.skipped += 1;
        continue;
      }

      const history = await query<{ direction: string; author_name: string | null; body: string | null; attachments: Attachment[] }>(
        `SELECT direction, author_name, body, attachments FROM messages
          WHERE conversation_id = $1 AND status <> 'discarded'
          ORDER BY created_at DESC LIMIT $2`,
        [p.conversationId, MAX_CONTEXT_MESSAGES],
      );
      const snapshot = await opsSnapshot(p.orgId);
      const conversation = history
        .reverse()
        .map((m) => `${m.direction === "in" ? (m.author_name ?? "Nhân viên") : "Dương Quá"}: ${redactForAi(m.body ?? "")} ${describeAttachments(m.attachments ?? [])}`.trimEnd())
        .join("\n");

      const user = buildAssistPrompt({
        where: p.kind === "group" ? `nhóm ${p.title ?? ""}` : `nhắn riêng với ${p.contactName ?? "nhân viên"}`,
        conversation,
        snapshot,
        roster: await teamRoster(p.orgId),
      });

      const model = guestModel();
      const run = await queryOne<{ id: string }>(
        `INSERT INTO agent_runs (org_id, agent_role, task_key, entity_type, entity_id, tools_allowed, status, attempt, started_at, heartbeat_at, input)
         VALUES ($1,'manager',$2,'message',$3,'{tra_loi}','running',1,now(),now(),$4)
         ON CONFLICT (org_id, agent_role, task_key) DO NOTHING RETURNING id`,
        [p.orgId, `staff_assist:${target.id}`, target.id, JSON.stringify({ model, conversationId: p.conversationId, kind: p.kind })],
      );
      if (!run) {
        out.skipped += 1;
        continue;
      }

      let res: Awaited<ReturnType<typeof callTool<ToolOut>>>;
      try {
        res = await callTool<ToolOut>({ system: SYSTEM, user, tool: TOOL, model, maxTokens: 700 });
        // Hứa báo lên nhóm mà không soạn tin: gọi lại đúng MỘT lần với lệnh dứt khoát.
        if (p.kind === "staff" && loiHuaChuaLam(String(res.input.message ?? ""), String(res.input.group_message ?? ""))) {
          res = await callTool<ToolOut>({ system: SYSTEM, user: `${user}
${LENH_LAM_NGAY}`, tool: TOOL, model, maxTokens: 700 });
        }
      } catch (error) {
        const e = error as AiError;
        await query("UPDATE agent_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1", [run.id, e?.code === "timeout" ? "timed_out" : "failed", e?.message ?? "loi AI"]);
        out.failed += 1;
        continue;
      }

      const usage = { model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: Number(res.costUsd.toFixed(6)) };
      /**
       * Đăng lên nhóm khi người nhắn riêng yêu cầu. Chỉ từ hội thoại riêng: nếu cho phép cả trong nhóm
       * thì tin nó đăng lại thành tin mới của nhóm và có thể tự kích hoạt vòng sau — nói chuyện một mình.
       */
      const groupBody = p.kind === "staff" ? String(res.input.group_message ?? "").trim() : "";
      // Model hay điền group_message rồi bỏ trống message. Trống mà bỏ qua cả lượt thì tin nhóm mất luôn,
      // người nhờ cũng không nhận được xác nhận nào — nên tự trả lời thay bằng một câu xác nhận.
      const body = String(res.input.message ?? "").trim() || (groupBody ? "Dạ em đã báo lên nhóm ạ." : "");
      if (res.input.action !== "reply" || !body) {
        await query("UPDATE agent_runs SET status = 'succeeded', output = $2, cost_minor = $3, finished_at = now() WHERE id = $1", [
          run.id,
          JSON.stringify({ ...usage, action: "skip", note: res.input.note }),
          Math.ceil(res.costUsd * 100),
        ]);
        out.skipped += 1;
        continue;
      }

      const opsGroup = groupBody ? await opsGroupConversation(p.orgId) : null;
      const postedToGroup = Boolean(groupBody && opsGroup);

      await withTx(async (tx) => {
        await tx.query(
          `INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status, queued_at)
           VALUES ($1,$2,'out','system','Dương Quá — trợ lý',$3,'queued',now())`,
          [p.orgId, p.conversationId, body.slice(0, 3000)],
        );
        await tx.query("UPDATE conversations SET last_message_at = now(), unread_count = 0, updated_at = now() WHERE id = $1", [p.conversationId]);
        if (postedToGroup && opsGroup) {
          await tx.query(
            `INSERT INTO messages (org_id, conversation_id, direction, author_type, author_name, body, status, queued_at)
             VALUES ($1,$2,'out','system','Dương Quá — trợ lý',$3,'queued',now())`,
            [p.orgId, opsGroup.id, groupBody.slice(0, 3000)],
          );
          await tx.query("UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1", [opsGroup.id]);
        }
      });
      await query("UPDATE agent_runs SET status = 'succeeded', output = $2, cost_minor = $3, finished_at = now() WHERE id = $1", [
        run.id,
        JSON.stringify({ ...usage, action: "reply", note: res.input.note, length: body.length, postedToGroup }),
        Math.ceil(res.costUsd * 100),
      ]);
      out.answered += 1;
      if (postedToGroup) out.postedToGroup += 1;
    } catch (error) {
      console.error("[staff-assist] lỗi hội thoại", p.conversationId, (error as Error)?.message);
      out.failed += 1;
    }
  }
  return out;
}
