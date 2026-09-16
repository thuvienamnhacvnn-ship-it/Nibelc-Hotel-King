import { z } from "zod";
import { queryOne } from "@/lib/db";
import { api, readJson } from "@/lib/http";
import { isValidDate, todayOps } from "@/lib/time";
import { assertCan } from "@/modules/auth/actor";
import { MIN_SCORE, findGroundedAnswer } from "@/modules/qa/retrieval";

const input = z.object({
  text: z.string().trim().min(1, "Nhập câu hỏi để thử").max(1000),
  unitId: z.string().uuid().nullish(),
  propertyId: z.string().uuid().nullish(),
  verification: z.enum(["none", "matched", "verified"]).default("none"),
  language: z.enum(["en", "vi"]).default("en"),
  opsDate: z
    .string()
    .nullish()
    .refine((v) => !v || isValidDate(v), { message: "Ngày không hợp lệ" }),
});

/**
 * POST /api/v1/qa/lookup { text, unitId?, propertyId?, verification?, language?, opsDate? }
 * Thử tra cứu đúng như bot sẽ dùng (chỉ bản đã duyệt, còn hiệu lực). Trả { answer | null, grounding, minScore, opsDate }.
 * Chỉ đọc — không ghi nhật ký, không gửi gì cho khách.
 */
export const POST = api(async (req, actor) => {
  assertCan(actor, "qa.view");
  const q = input.parse(await readJson(req));
  const opsDate = q.opsDate || todayOps(actor.timezone);
  const answer = await findGroundedAnswer({ orgId: actor.orgId, text: q.text, unitId: q.unitId, propertyId: q.propertyId, verification: q.verification, language: q.language, opsDate });
  const grounding = answer
    ? await queryOne<{ question: string; variants: string[]; source: string | null; handoff_condition: string | null; valid_from: string | null; valid_to: string | null; approved_at: Date | null; approved_by_name: string | null; property_code: string | null; unit_code: string | null }>(
        `SELECT e.question, e.variants, e.source, e.handoff_condition, e.valid_from, e.valid_to, e.approved_at, au.full_name AS approved_by_name, p.code AS property_code, u.code AS unit_code
           FROM qa_entries e
           LEFT JOIN users au ON au.id = e.approved_by
           LEFT JOIN properties p ON p.id = e.property_id AND p.org_id = e.org_id
           LEFT JOIN units u ON u.id = e.unit_id AND u.org_id = e.org_id
          WHERE e.id = $1 AND e.org_id = $2`,
        [answer.entryId, actor.orgId],
      )
    : null;
  return { answer, grounding, minScore: MIN_SCORE, opsDate };
});
