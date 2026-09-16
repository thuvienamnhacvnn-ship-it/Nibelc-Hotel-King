/**
 * Mục Kho Q&A DEMO cho tổ chức nibelc-demo. Mọi mục is_demo = true, đi qua service (kiểm bí mật, phạm vi, nhật ký).
 * Nội dung chỉ lấy quy tắc chung đã có trong file Vietnam Team (giờ nhận/trả, nhận sớm từ 12:00, trả muộn tới 13:00);
 * chưa có dữ liệu (đỗ xe) hay dữ liệu nhạy cảm (mã cửa) ⇒ mức "luôn chuyển người". KHÔNG có mật khẩu Wi-Fi, mã cửa, địa chỉ thật.
 *
 * Chạy lặp an toàn: mục đã có (cùng câu hỏi + phạm vi) thì bỏ qua.
 * Chạy: npx tsx scripts/seed-qa-demo.ts   (database đã migrate tới 0003; tổ chức nibelc-demo đã seed)
 */
import { loadLocalEnv } from "../src/lib/env";

loadLocalEnv();

const { closePool, queryOne } = await import("../src/lib/db");
const { userActor } = await import("../src/modules/auth/actor");
const { approveQaEntry, createQaDraft, reviseQaEntry, submitQaForReview } = await import("../src/modules/qa/service");
type Role = import("../src/modules/auth/permissions").Role;

const SOURCE = "DEMO — theo quy tắc chung trong file Vietnam Team (chưa đối chiếu nội quy từng nhà)";

interface Seed {
  scope: "general" | "property" | "unit";
  property?: string;
  unit?: string;
  topic: string;
  question: string;
  variants: string[];
  answerEn: string;
  answerVi?: string;
  sensitivity?: "public" | "restricted" | "handoff";
  handoffCondition?: string;
  source?: string;
  /** Trạng thái cuối mong muốn */
  status: "draft" | "pending_review" | "approved";
}

const SEEDS: Seed[] = [
  {
    scope: "general",
    topic: "check-in",
    question: "What time is check-in?",
    variants: ["When can I check in?", "Check-in time", "Mấy giờ nhận phòng?", "Giờ nhận phòng"],
    answerEn: "Check-in is from 15:00 to 23:00 (Budapest time).",
    answerVi: "Nhận phòng từ 15:00 đến 23:00 (giờ Budapest).",
    status: "approved",
  },
  {
    scope: "general",
    topic: "check-out",
    question: "What time is check-out?",
    variants: ["When do I have to leave?", "Check-out time", "Mấy giờ trả phòng?"],
    answerEn: "Check-out is by 10:00 (Budapest time).",
    answerVi: "Trả phòng trước 10:00 (giờ Budapest).",
    status: "approved",
  },
  {
    scope: "general",
    topic: "check-in",
    question: "Can I check in early?",
    variants: ["Early check-in", "Can I arrive before 15:00?", "Nhận phòng sớm được không?"],
    answerEn:
      "Early check-in from 12:00 may be possible, depending on availability and cleaning. Please send us your arrival time — our team will confirm, and a fee may apply.",
    answerVi: "Có thể nhận phòng sớm từ 12:00 tuỳ tình trạng phòng và lịch dọn. Vui lòng báo giờ đến — đội ngũ sẽ xác nhận, có thể có phụ thu.",
    status: "approved",
  },
  {
    scope: "general",
    topic: "check-out",
    question: "Can I check out late?",
    variants: ["Late check-out", "Can I stay until 13:00?", "Trả phòng muộn được không?"],
    answerEn: "Late check-out until 13:00 at the latest may be possible, depending on availability and the next booking. Please ask us in advance — our team will confirm, and a fee may apply.",
    answerVi: "Có thể trả phòng muộn, tối đa 13:00, tuỳ tình trạng phòng và booking kế tiếp. Vui lòng hỏi trước — đội ngũ sẽ xác nhận, có thể có phụ thu.",
    status: "approved",
  },
  {
    scope: "general",
    topic: "wifi",
    question: "Is there Wi-Fi?",
    variants: ["What is the Wi-Fi password?", "wifi password", "Internet", "Có wifi không?", "Mật khẩu wifi là gì?"],
    answerEn: "Yes, Wi-Fi is available. The network name and password are posted inside the room.",
    answerVi: "Có Wi-Fi. Tên mạng và mật khẩu được dán trong phòng.",
    status: "approved",
  },
  {
    scope: "general",
    topic: "parking",
    question: "Is there parking?",
    variants: ["Where can I park my car?", "Parking", "Có chỗ đỗ xe không?", "Gửi xe ở đâu?"],
    answerEn: "Let me check parking options with our team — they will get back to you.",
    sensitivity: "handoff",
    handoffCondition: "Chưa có dữ liệu đỗ xe đã xác nhận cho các nhà — luôn chuyển người",
    status: "approved",
  },
  {
    scope: "general",
    topic: "door access",
    question: "What is the door code?",
    variants: ["How do I get into the apartment?", "key box", "access code", "Mã cửa là gì?", "Lấy chìa khoá ở đâu?"],
    answerEn: "Access details are only shared through our secure access process after your booking is verified. Our team will help you.",
    answerVi: "Thông tin vào nhà chỉ gửi qua quy trình truy cập có kiểm quyền sau khi xác minh booking. Đội ngũ sẽ hỗ trợ bạn.",
    sensitivity: "handoff",
    handoffCondition: "Mã cửa/hộp khoá chỉ lấy qua công cụ truy cập có kiểm quyền theo booking — không bao giờ trả từ Q&A",
    status: "approved",
  },
  {
    scope: "general",
    topic: "luggage",
    question: "Can I leave my luggage before check-in?",
    variants: ["Luggage storage", "Gửi hành lý trước giờ nhận phòng được không?"],
    answerEn: "Please ask our team — luggage storage depends on the apartment and the cleaning schedule.",
    sensitivity: "handoff",
    handoffCondition: "Chưa có quy định gửi hành lý — chờ Budapest Team xác nhận",
    status: "pending_review",
  },
  {
    scope: "property",
    property: "DEMO-A",
    topic: "check-in",
    question: "How do I find the apartment?",
    variants: ["Directions to the apartment", "Đường tới nhà"],
    answerEn: "DEMO sample: Nhà Demo A is at a sample address (Demo utca 1). Detailed arrival instructions are sent after your booking is matched.",
    sensitivity: "restricted",
    source: "DEMO — địa chỉ mẫu, không phải nhà thật",
    status: "approved",
  },
  {
    scope: "unit",
    unit: "A001",
    topic: "towels",
    question: "Are towels provided?",
    variants: ["Towels", "Có khăn tắm không?"],
    answerEn: "DEMO draft: replace with the confirmed towel and linen information for this room.",
    source: "DEMO — nháp chờ Budapest Team điền nội dung thật",
    status: "draft",
  },
];

async function main() {
  const org = await queryOne<{ id: string }>("SELECT id FROM organizations WHERE slug = 'nibelc-demo'");
  if (!org) throw new Error("Chưa có tổ chức nibelc-demo — chạy db:seed trước.");
  const qaCount = await queryOne<{ ok: boolean }>("SELECT to_regclass('public.qa_entries') IS NOT NULL AS ok");
  if (!qaCount?.ok) throw new Error("Chưa có bảng qa_entries — database chưa migrate tới 0003.");

  const actorFor = async (email: string) => {
    const u = await queryOne<{ id: string; full_name: string; role: Role }>("SELECT id, full_name, role FROM users WHERE org_id = $1 AND email = $2", [org.id, email]);
    if (!u) throw new Error(`Thiếu tài khoản DEMO ${email}`);
    return userActor({ userId: u.id, orgId: org.id, role: u.role, fullName: u.full_name, timezone: "Europe/Budapest" });
  };
  // Hoà (Vietnam Team) soạn, Thảo (điều phối Budapest) duyệt — người soạn không tự duyệt.
  const author = await actorFor("hoa@demo.nibelc.local");
  const approver = await actorFor("thao@demo.nibelc.local");

  const idOf = async (table: "properties" | "units", code: string) => {
    const r = await queryOne<{ id: string }>(`SELECT id FROM ${table} WHERE org_id = $1 AND code = $2`, [org.id, code]);
    if (!r) throw new Error(`Thiếu ${table} ${code} trong DEMO`);
    return r.id;
  };

  let created = 0;
  let skipped = 0;
  for (const seed of SEEDS) {
    const propertyId = seed.property ? await idOf("properties", seed.property) : null;
    const unitId = seed.unit ? await idOf("units", seed.unit) : null;
    const exists = await queryOne(
      `SELECT 1 FROM qa_entries WHERE org_id = $1 AND is_demo AND question = $2 AND scope = $3
          AND (($3 = 'property' AND property_id = $4::uuid) OR ($3 = 'unit' AND unit_id = $5::uuid) OR $3 = 'general') LIMIT 1`,
      [org.id, seed.question, seed.scope, propertyId, unitId],
    );
    if (exists) {
      skipped++;
      continue;
    }
    const { status, property: _p, unit: _u, ...content } = seed;
    const draft = await createQaDraft(author, { ...content, propertyId, unitId, source: seed.source ?? SOURCE }, { isDemo: true });
    if (status !== "draft") await submitQaForReview(author, draft.id);
    if (status === "approved") await approveQaEntry(approver, draft.id);
    created++;
  }

  // Minh hoạ phiên bản: giờ nhận phòng có bản sửa v2 đang nháp (bot vẫn dùng v1 tới khi duyệt).
  const checkin = await queryOne<{ id: string; entry_key: string }>(
    "SELECT id, entry_key FROM qa_entries WHERE org_id = $1 AND is_demo AND scope = 'general' AND question = 'What time is check-in?' AND status = 'approved'",
    [org.id],
  );
  if (checkin) {
    const hasV2 = await queryOne("SELECT 1 FROM qa_entries WHERE org_id = $1 AND entry_key = $2 AND version > 1", [org.id, checkin.entry_key]);
    if (!hasV2) {
      const base = SEEDS[0];
      await reviseQaEntry(author, checkin.id, {
        content: {
          scope: "general",
          topic: base.topic,
          question: base.question,
          variants: [...base.variants, "Arrival time"],
          answerEn: "Check-in is from 15:00 to 23:00 (Budapest time). If you arrive after 23:00, please tell us in advance so our team can help.",
          answerVi: "Nhận phòng từ 15:00 đến 23:00 (giờ Budapest). Nếu đến sau 23:00, vui lòng báo trước để đội ngũ hỗ trợ.",
          source: SOURCE,
        },
      });
      created++;
    }
  }
  console.log(`Kho Q&A DEMO: tạo ${created} mục/phiên bản, bỏ qua ${skipped} mục đã có.`);
}

try {
  await main();
} finally {
  await closePool();
}
