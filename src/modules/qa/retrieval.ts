import { query, queryOne } from "@/lib/db";
import type { FindGroundedAnswer, GroundedAnswer, GroundingQuery } from "./contract";
import { isValidDate } from "@/lib/time";
import { keywordTokens } from "./text";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v: string | null | undefined) => (v && UUID_RE.test(v) ? v : null);

/**
 * Tra cứu câu trả lời đã duyệt theo từ khoá — không dùng mô hình AI.
 * Điểm = mức phủ từ khoá của câu hỏi mẫu (hoặc biến thể) trong câu khách hỏi, cộng một ít nếu nhắc tới chủ đề.
 * Dưới ngưỡng ⇒ null: bên gọi phải chuyển người, không đoán.
 */
export const MIN_SCORE = 0.5;
/** Mục hẹp hơn (phòng → nhà → chung) thắng nếu điểm không kém mục tốt nhất quá khoảng này. */
const SCOPE_MARGIN = 0.2;
const SCOPE_RANK = { unit: 3, property: 2, general: 1 } as const;

export interface QaCandidateRow {
  id: string;
  entry_key: string;
  version: number;
  scope: "general" | "property" | "unit";
  topic: string;
  question: string;
  variants: string[];
  answer_en: string;
  answer_vi: string | null;
  sensitivity: "public" | "restricted" | "handoff";
}

/** Từ chung chung ("mấy giờ", "when") khớp một mình không đủ để coi là cùng câu hỏi. */
const WEAK_TOKENS = new Set(["time", "room", "phong"]);
const weightOf = (t: string) => (WEAK_TOKENS.has(t) ? 0.3 : 1);
const totalWeight = (tokens: Set<string>) => [...tokens].reduce((sum, t) => sum + weightOf(t), 0);

function overlapScore(q: Set<string>, candidate: Set<string>): number {
  if (q.size === 0 || candidate.size === 0) return 0;
  let inter = 0;
  for (const t of candidate) if (q.has(t)) inter += weightOf(t);
  if (inter === 0) return 0;
  return 0.75 * (inter / totalWeight(candidate)) + 0.25 * (inter / totalWeight(q));
}

export function scoreEntry(questionText: string | Set<string>, entry: Pick<QaCandidateRow, "question" | "variants" | "topic">): number {
  const q = typeof questionText === "string" ? keywordTokens(questionText) : questionText;
  let best = 0;
  for (const text of [entry.question, ...(entry.variants ?? [])]) best = Math.max(best, overlapScore(q, keywordTokens(text)));
  if (best === 0) return 0;
  const topic = keywordTokens(entry.topic);
  if ([...topic].some((t) => q.has(t))) best += 0.1;
  return Math.round(Math.min(1, best) * 100) / 100;
}

export const findGroundedAnswer: FindGroundedAnswer = async (input: GroundingQuery) => {
  const q = keywordTokens(input.text ?? "");
  // Tham số sai dạng thì dừng trước khi chạy SQL (bẫy PGlite: câu lệnh lỗi làm lệch kết nối).
  if (q.size === 0 || !asUuid(input.orgId) || !isValidDate(input.opsDate ?? "")) return null;

  // Chỉ nhận id phòng/nhà thuộc đúng tổ chức; có phòng mà thiếu nhà thì lấy nhà của phòng.
  let unitId: string | null = null;
  let propertyId: string | null = null;
  if (asUuid(input.unitId)) {
    const unit = await queryOne<{ id: string; property_id: string }>("SELECT id, property_id FROM units WHERE id = $1 AND org_id = $2", [input.unitId, input.orgId]);
    if (unit) {
      unitId = unit.id;
      propertyId = unit.property_id;
    }
  }
  if (!propertyId && asUuid(input.propertyId)) {
    const prop = await queryOne<{ id: string }>("SELECT id FROM properties WHERE id = $1 AND org_id = $2", [input.propertyId, input.orgId]);
    propertyId = prop?.id ?? null;
  }

  const rows = await query<QaCandidateRow>(
    `SELECT id, entry_key, version, scope, topic, question, variants, answer_en, answer_vi, sensitivity
       FROM qa_entries
      WHERE org_id = $1
        AND status = 'approved'
        AND (valid_from IS NULL OR valid_from <= $2::date)
        AND (valid_to IS NULL OR valid_to >= $2::date)
        AND (scope = 'general'
             OR (scope = 'property' AND property_id = $3::uuid)
             OR (scope = 'unit' AND unit_id = $4::uuid))
        AND ($5::boolean OR sensitivity <> 'restricted')`,
    [input.orgId, input.opsDate, propertyId, unitId, input.verification !== "none"],
  );

  const scored = rows.map((row) => ({ row, score: scoreEntry(q, row) })).filter((c) => c.score >= MIN_SCORE);
  if (scored.length === 0) return null;
  const top = Math.max(...scored.map((c) => c.score));
  const pick = scored
    .filter((c) => c.score >= top - SCOPE_MARGIN)
    .sort((a, b) => SCOPE_RANK[b.row.scope] - SCOPE_RANK[a.row.scope] || b.score - a.score || a.row.id.localeCompare(b.row.id))[0];

  const wantsVi = input.language === "vi" && !!pick.row.answer_vi;
  const result: GroundedAnswer = {
    entryId: pick.row.id,
    entryKey: pick.row.entry_key,
    version: pick.row.version,
    scope: pick.row.scope,
    topic: pick.row.topic,
    answer: wantsVi ? pick.row.answer_vi! : pick.row.answer_en,
    language: wantsVi ? "vi" : "en",
    sensitivity: pick.row.sensitivity,
    score: pick.score,
  };
  return result;
};
