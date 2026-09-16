import type pg from "pg";
import { z } from "zod";
import { withTx } from "@/lib/db";
import { AppError, conflict, forbidden, invalid, notFound } from "@/lib/errors";
import { isValidDate } from "@/lib/time";
import { type Actor, assertCan } from "@/modules/auth/actor";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";
import { QA_SCOPES, QA_SENSITIVITIES, type QA_STATUSES } from "./labels";
import { SECRET_REJECT_MESSAGE, looksLikeSecret } from "./text";

/**
 * Kho Q&A (đặc tả mục 4). Vòng đời một phiên bản: draft → pending_review → approved → retired.
 *   - Sửa câu đã duyệt KHÔNG ghi đè: tạo phiên bản mới (version+1, cùng entry_key) ở trạng thái nháp.
 *     Khi duyệt bản mới, bản đang duyệt cũ chuyển 'retired' trong cùng giao dịch (mỗi entry_key chỉ một bản approved).
 *   - Người tạo không tự duyệt (DB có CHECK; service kiểm trước để báo lỗi rõ và tránh lỗi SQL — bẫy PGlite).
 *   - Không lưu mã cửa/mật khẩu: nội dung giống bí mật bị từ chối 422.
 * Chống ghi đè: client gửi `expectedUpdatedAt`; khác ⇒ 409 stale_version.
 */


const UUID = z.string().uuid();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const dateField = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidDate(v), { message: "Ngày hiệu lực không hợp lệ (YYYY-MM-DD)" });

export const qaContentInput = z
  .object({
    scope: z.enum(QA_SCOPES, { message: "Phạm vi không hợp lệ" }),
    propertyId: UUID.nullish(),
    unitId: UUID.nullish(),
    topic: z.string().trim().min(1, "Cần chủ đề").max(80, "Chủ đề tối đa 80 ký tự"),
    question: z.string().trim().min(3, "Cần câu hỏi").max(500, "Câu hỏi tối đa 500 ký tự"),
    variants: z
      .array(z.string().trim().max(300, "Mỗi biến thể tối đa 300 ký tự"))
      .max(30, "Tối đa 30 biến thể")
      .default([])
      .transform((list) => [...new Set(list.filter(Boolean))]),
    answerEn: z.string().trim().min(1, "Cần câu trả lời tiếng Anh (bản đầu là English)").max(4000),
    answerVi: optionalText(4000),
    sensitivity: z.enum(QA_SENSITIVITIES, { message: "Mức nhạy cảm không hợp lệ" }).default("public"),
    handoffCondition: optionalText(1000),
    source: optionalText(1000),
    validFrom: dateField,
    validTo: dateField,
  })
  .refine((v) => v.scope !== "property" || !!v.propertyId, { message: "Phạm vi theo nhà cần chọn nhà", path: ["propertyId"] })
  .refine((v) => v.scope !== "unit" || !!v.unitId, { message: "Phạm vi theo phòng cần chọn phòng", path: ["unitId"] })
  .refine((v) => !v.validFrom || !v.validTo || v.validFrom <= v.validTo, { message: "Ngày hết hiệu lực phải sau ngày bắt đầu", path: ["validTo"] })
  .refine((v) => v.sensitivity !== "handoff" || !!v.handoffCondition, { message: "Mức 'chuyển người' cần ghi điều kiện chuyển người", path: ["handoffCondition"] });
export type QaContentInput = z.infer<typeof qaContentInput>;

const expectedUpdatedAt = z.string().datetime({ offset: true }).optional();
const updateInput = z.object({ expectedUpdatedAt, content: qaContentInput });
const reasonInput = z.object({ expectedUpdatedAt, reason: z.string().trim().min(3, "Cần ghi lý do").max(1000) });
const stepInput = z.object({ expectedUpdatedAt }).default({});

export interface QaEntryRow {
  id: string;
  org_id: string;
  entry_key: string;
  version: number;
  scope: (typeof QA_SCOPES)[number];
  property_id: string | null;
  unit_id: string | null;
  topic: string;
  question: string;
  variants: string[];
  answer_en: string;
  answer_vi: string | null;
  sensitivity: (typeof QA_SENSITIVITIES)[number];
  handoff_condition: string | null;
  source: string | null;
  status: (typeof QA_STATUSES)[number];
  valid_from: string | null;
  valid_to: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  is_demo: boolean;
  created_at: Date;
  updated_at: Date;
}

function assertId(id: string) {
  if (!UUID.safeParse(id).success) throw notFound("mục Q&A");
}

function assertFresh(updatedAt: Date, expected: string | undefined) {
  if (expected && new Date(updatedAt).getTime() !== new Date(expected).getTime()) {
    throw new AppError("stale_version", "Mục Q&A đã được người khác sửa sau khi bạn mở. Tải lại rồi làm tiếp.", 409);
  }
}

/** Chặn nội dung giống mã cửa/mật khẩu ở mọi trường chữ mà bot có thể đọc ra. */
export function assertNoSecrets(content: Pick<QaContentInput, "question" | "variants" | "answerEn" | "answerVi" | "handoffCondition" | "source">) {
  const fields: [string, string | null | undefined][] = [
    ["question", content.question],
    ["answerEn", content.answerEn],
    ["answerVi", content.answerVi],
    ["handoffCondition", content.handoffCondition],
    ["source", content.source],
    ...content.variants.map((v, i): [string, string] => [`variants.${i}`, v]),
  ];
  const hits = fields.filter(([, text]) => looksLikeSecret(text)).map(([path]) => path);
  if (hits.length) throw new AppError("secret_content", SECRET_REJECT_MESSAGE, 422, { fields: hits });
}

/** Phạm vi → cặp (property_id, unit_id) khớp CHECK; nhà/phòng phải thuộc tổ chức. Phòng thì ghi kèm nhà của phòng để lọc. */
async function resolveScope(tx: pg.PoolClient, actor: Actor, content: QaContentInput) {
  if (content.scope === "general") return { propertyId: null, unitId: null };
  if (content.scope === "property") {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM properties WHERE id = $1 AND org_id = $2", [content.propertyId, actor.orgId]);
    if (!rows[0]) throw invalid("Nhà không tồn tại trong tổ chức.", { issues: [{ message: "Chọn lại nhà" }] });
    return { propertyId: rows[0].id, unitId: null };
  }
  const { rows } = await tx.query<{ id: string; property_id: string }>("SELECT id, property_id FROM units WHERE id = $1 AND org_id = $2", [content.unitId, actor.orgId]);
  if (!rows[0]) throw invalid("Phòng không tồn tại trong tổ chức.", { issues: [{ message: "Chọn lại phòng" }] });
  return { propertyId: rows[0].property_id, unitId: rows[0].id };
}

/** Người sửa nội dung gần nhất của một phiên bản (null nếu chưa ai sửa sau khi tạo). Không cần cột mới — đọc nhật ký. */
export async function lastContentEditor(client: Pick<pg.PoolClient, "query">, orgId: string, entryId: string): Promise<string | null> {
  const { rows } = await client.query<{ actor_id: string | null }>(
    `SELECT actor_id FROM audit_log
      WHERE org_id = $1 AND entity_type = 'qa_entry' AND entity_id = $2 AND action = 'qa.update'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [orgId, entryId],
  );
  return rows[0]?.actor_id ?? null;
}

async function lockEntry(tx: pg.PoolClient, actor: Actor, id: string) {
  assertId(id);
  const { rows } = await tx.query<QaEntryRow>("SELECT * FROM qa_entries WHERE id = $1 AND org_id = $2 FOR UPDATE", [id, actor.orgId]);
  if (!rows[0]) throw notFound("mục Q&A");
  return rows[0];
}

function contentSnapshot(row: Pick<QaEntryRow, "scope" | "property_id" | "unit_id" | "topic" | "question" | "sensitivity" | "valid_from" | "valid_to">) {
  // Nhật ký giữ các trường nhận diện; toàn văn câu trả lời nằm ở chính phiên bản (không bao giờ ghi đè).
  return { scope: row.scope, propertyId: row.property_id, unitId: row.unit_id, topic: row.topic, question: row.question, sensitivity: row.sensitivity, validFrom: row.valid_from, validTo: row.valid_to };
}

async function insertVersion(
  tx: pg.PoolClient,
  actor: Actor,
  content: QaContentInput,
  scope: { propertyId: string | null; unitId: string | null },
  entry: { entryKey: string | null; version: number; isDemo: boolean },
) {
  const { rows } = await tx.query<QaEntryRow>(
    `INSERT INTO qa_entries (org_id, entry_key, version, scope, property_id, unit_id, topic, question, variants, answer_en, answer_vi,
                             sensitivity, handoff_condition, source, status, valid_from, valid_to, created_by, is_demo)
     VALUES ($1, coalesce($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft', $15, $16, $17, $18)
     RETURNING *`,
    [
      actor.orgId,
      entry.entryKey,
      entry.version,
      content.scope,
      scope.propertyId,
      scope.unitId,
      content.topic,
      content.question,
      content.variants,
      content.answerEn,
      content.answerVi,
      content.sensitivity,
      content.handoffCondition,
      content.source,
      content.validFrom,
      content.validTo,
      actor.userId,
      entry.isDemo,
    ],
  );
  return rows[0];
}

export async function createQaDraft(actor: Actor, raw: unknown, opts: { isDemo?: boolean } = {}) {
  assertCan(actor, "qa.edit");
  const content = qaContentInput.parse(raw);
  assertNoSecrets(content);
  return withTx(async (tx) => {
    const scope = await resolveScope(tx, actor, content);
    const row = await insertVersion(tx, actor, content, scope, { entryKey: null, version: 1, isDemo: !!opts.isDemo });
    await writeAudit(tx, auditActorOf(actor), "qa.create", "qa_entry", row.id, { entryKey: row.entry_key, version: 1, ...contentSnapshot(row) });
    return row;
  });
}

/** Sửa nội dung một bản nháp/chờ duyệt. Bản chờ duyệt bị sửa quay về nháp (phải gửi duyệt lại). */
export async function updateQaDraft(actor: Actor, id: string, raw: unknown) {
  assertCan(actor, "qa.edit");
  assertId(id);
  const input = updateInput.parse(raw);
  assertNoSecrets(input.content);
  return withTx(async (tx) => {
    const row = await lockEntry(tx, actor, id);
    assertFresh(row.updated_at, input.expectedUpdatedAt);
    if (row.status !== "draft" && row.status !== "pending_review") {
      throw conflict("qa_not_editable", row.status === "approved" ? "Bản đã duyệt không sửa trực tiếp — dùng “Sửa thành phiên bản mới”." : "Bản đã ngưng dùng không sửa được.");
    }
    const c = input.content;
    const scope = await resolveScope(tx, actor, c);
    const { rows } = await tx.query<QaEntryRow>(
      `UPDATE qa_entries SET scope = $3, property_id = $4, unit_id = $5, topic = $6, question = $7, variants = $8, answer_en = $9, answer_vi = $10,
              sensitivity = $11, handoff_condition = $12, source = $13, valid_from = $14, valid_to = $15, status = 'draft', updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [id, actor.orgId, c.scope, scope.propertyId, scope.unitId, c.topic, c.question, c.variants, c.answerEn, c.answerVi, c.sensitivity, c.handoffCondition, c.source, c.validFrom, c.validTo],
    );
    await writeAudit(tx, auditActorOf(actor), "qa.update", "qa_entry", id, { entryKey: row.entry_key, version: row.version, fromStatus: row.status, before: contentSnapshot(row), after: contentSnapshot(rows[0]) });
    return rows[0];
  });
}

/** Sửa câu đã duyệt (hoặc đã ngưng) = tạo phiên bản mới ở trạng thái nháp; bản cũ vẫn chạy tới khi bản mới được duyệt. */
export async function reviseQaEntry(actor: Actor, id: string, raw: unknown) {
  assertCan(actor, "qa.edit");
  assertId(id);
  const input = updateInput.parse(raw);
  assertNoSecrets(input.content);
  return withTx(async (tx) => {
    const base = await lockEntry(tx, actor, id);
    assertFresh(base.updated_at, input.expectedUpdatedAt);
    if (base.status === "draft" || base.status === "pending_review") throw conflict("qa_use_edit", "Bản này chưa duyệt — sửa trực tiếp, không cần tạo phiên bản mới.");
    // Khoá mọi phiên bản của câu hỏi để hai người không cùng tạo version+1.
    const { rows: versions } = await tx.query<{ id: string; version: number; status: string }>(
      "SELECT id, version, status FROM qa_entries WHERE org_id = $1 AND entry_key = $2 ORDER BY version FOR UPDATE",
      [actor.orgId, base.entry_key],
    );
    const open = versions.find((v) => v.status === "draft" || v.status === "pending_review");
    if (open) throw conflict("qa_open_version_exists", `Câu hỏi này đang có phiên bản ${open.version} chưa duyệt — sửa bản đó thay vì tạo thêm.`, { openId: open.id });
    const nextVersion = Math.max(...versions.map((v) => v.version)) + 1;
    const c = input.content;
    const scope = await resolveScope(tx, actor, c);
    const row = await insertVersion(tx, actor, c, scope, { entryKey: base.entry_key, version: nextVersion, isDemo: base.is_demo });
    await writeAudit(tx, auditActorOf(actor), "qa.revise", "qa_entry", row.id, { entryKey: row.entry_key, version: nextVersion, basedOn: { id: base.id, version: base.version }, ...contentSnapshot(row) });
    return row;
  });
}

export async function submitQaForReview(actor: Actor, id: string, raw: unknown = {}) {
  assertCan(actor, "qa.edit");
  assertId(id);
  const input = stepInput.parse(raw ?? {});
  return withTx(async (tx) => {
    const row = await lockEntry(tx, actor, id);
    assertFresh(row.updated_at, input.expectedUpdatedAt);
    if (row.status !== "draft") throw conflict("qa_bad_status", "Chỉ gửi duyệt được bản nháp.");
    const { rows } = await tx.query<QaEntryRow>("UPDATE qa_entries SET status = 'pending_review', updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *", [id, actor.orgId]);
    await writeAudit(tx, auditActorOf(actor), "qa.submit", "qa_entry", id, { entryKey: row.entry_key, version: row.version });
    return rows[0];
  });
}

export async function approveQaEntry(actor: Actor, id: string, raw: unknown = {}) {
  assertCan(actor, "qa.approve");
  assertId(id);
  const input = stepInput.parse(raw ?? {});
  if (!actor.userId) throw forbidden("Duyệt Q&A phải do một người dùng thực hiện.");
  return withTx(async (tx) => {
    const row = await lockEntry(tx, actor, id);
    assertFresh(row.updated_at, input.expectedUpdatedAt);
    if (row.status !== "pending_review") throw conflict("qa_bad_status", "Chỉ duyệt được bản đang chờ duyệt.");
    // Không tự duyệt: người tạo phiên bản (created_by giữ nguyên) VÀ người sửa nội dung gần nhất (lấy từ nhật ký qa.update).
    const lastEditor = await lastContentEditor(tx, actor.orgId, id);
    if ((row.created_by && row.created_by === actor.userId) || lastEditor === actor.userId) {
      throw new AppError("self_approval", "Người tạo hoặc người sửa nội dung gần nhất không tự duyệt — nhờ người khác có quyền duyệt.", 403);
    }
    // Kiểm lại lúc duyệt: nội dung có thể được ghi trước khi bộ lọc bí mật được siết.
    assertNoSecrets({ question: row.question, variants: row.variants, answerEn: row.answer_en, answerVi: row.answer_vi, handoffCondition: row.handoff_condition, source: row.source });

    const { rows: current } = await tx.query<{ id: string; version: number }>(
      "SELECT id, version FROM qa_entries WHERE org_id = $1 AND entry_key = $2 AND status = 'approved' AND id <> $3 FOR UPDATE",
      [actor.orgId, row.entry_key, id],
    );
    // Ngưng bản cũ TRƯỚC khi duyệt bản mới — unique index chỉ cho một bản approved mỗi entry_key.
    for (const old of current) {
      await tx.query("UPDATE qa_entries SET status = 'retired', updated_at = now() WHERE id = $1 AND org_id = $2", [old.id, actor.orgId]);
      await writeAudit(tx, auditActorOf(actor), "qa.retire", "qa_entry", old.id, { entryKey: row.entry_key, version: old.version, reason: `Thay bằng phiên bản ${row.version}` });
    }
    const { rows } = await tx.query<QaEntryRow>(
      "UPDATE qa_entries SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *",
      [id, actor.orgId, actor.userId],
    );
    await writeAudit(tx, auditActorOf(actor), "qa.approve", "qa_entry", id, { entryKey: row.entry_key, version: row.version, replaced: current.map((c) => c.version) });
    return rows[0];
  });
}

/** Từ chối bản chờ duyệt: quay về nháp, lý do ghi nhật ký để người soạn sửa. */
export async function rejectQaEntry(actor: Actor, id: string, raw: unknown) {
  assertCan(actor, "qa.approve");
  assertId(id);
  const input = reasonInput.parse(raw);
  return withTx(async (tx) => {
    const row = await lockEntry(tx, actor, id);
    assertFresh(row.updated_at, input.expectedUpdatedAt);
    if (row.status !== "pending_review") throw conflict("qa_bad_status", "Chỉ từ chối được bản đang chờ duyệt.");
    const { rows } = await tx.query<QaEntryRow>("UPDATE qa_entries SET status = 'draft', updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *", [id, actor.orgId]);
    await writeAudit(tx, auditActorOf(actor), "qa.reject", "qa_entry", id, { entryKey: row.entry_key, version: row.version, reason: input.reason });
    return rows[0];
  });
}

/** Ngưng dùng. Bản đã duyệt cần quyền duyệt (bot thôi trả lời); bỏ bản nháp chỉ cần quyền soạn. */
export async function retireQaEntry(actor: Actor, id: string, raw: unknown) {
  assertCan(actor, "qa.edit");
  assertId(id);
  const input = reasonInput.parse(raw);
  return withTx(async (tx) => {
    const row = await lockEntry(tx, actor, id);
    if (row.status === "approved") assertCan(actor, "qa.approve", "Ngưng bản đã duyệt cần quyền duyệt Q&A.");
    assertFresh(row.updated_at, input.expectedUpdatedAt);
    if (row.status === "retired") throw conflict("qa_bad_status", "Bản này đã ngưng dùng.");
    const { rows } = await tx.query<QaEntryRow>("UPDATE qa_entries SET status = 'retired', updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *", [id, actor.orgId]);
    await writeAudit(tx, auditActorOf(actor), "qa.retire", "qa_entry", id, { entryKey: row.entry_key, version: row.version, fromStatus: row.status, reason: input.reason });
    return rows[0];
  });
}
