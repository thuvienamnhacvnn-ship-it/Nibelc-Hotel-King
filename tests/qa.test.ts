import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { findGroundedAnswer } from "@/modules/qa/retrieval";
import {
  approveQaEntry,
  createQaDraft,
  rejectQaEntry,
  retireQaEntry,
  reviseQaEntry,
  submitQaForReview,
  updateQaDraft,
} from "@/modules/qa/service";
import { listQaEntries, qaEntryHistory } from "@/modules/qa/queries";
import { looksLikeSecret } from "@/modules/qa/text";
import { expectCode, makeFixture, type Fixture } from "./helpers";

const OPS = "2026-10-01";

/** Lỗi dữ liệu vào là ZodError (API đổi thành 422 invalid_input). */
async function expectInvalid(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(message);
}

function content(extra: Record<string, unknown> = {}) {
  return {
    scope: "general",
    topic: "check-in",
    question: "What time is check-in?",
    variants: ["When can I check in?", "Mấy giờ nhận phòng?"],
    answerEn: "Check-in is from 15:00 to 23:00 (Budapest time).",
    sensitivity: "public",
    ...extra,
  };
}

/** Tạo nháp bởi vn_staff, gửi duyệt, vn_manager duyệt. */
async function approved(f: Fixture, extra: Record<string, unknown> = {}) {
  const draft = await createQaDraft(f.actors.vn_staff, content(extra));
  await submitQaForReview(f.actors.vn_staff, draft.id);
  return approveQaEntry(f.actors.vn_manager, draft.id);
}

const ask = (f: Fixture, text: string, extra: Partial<Parameters<typeof findGroundedAnswer>[0]> = {}) =>
  findGroundedAnswer({ orgId: f.orgId, text, verification: "none", opsDate: OPS, ...extra });

describe("Kho Q&A — vòng đời và phiên bản", () => {
  it("sửa câu đã duyệt tạo phiên bản mới; duyệt bản mới thì bản cũ ngưng — chỉ một bản approved", async () => {
    const f = await makeFixture();
    const v1 = await approved(f);
    expect(v1.status).toBe("approved");

    // Bản đã duyệt không sửa trực tiếp.
    await expectCode(updateQaDraft(f.actors.vn_staff, v1.id, { content: content({ answerEn: "x" }) }), "qa_not_editable");

    const v2 = await reviseQaEntry(f.actors.vn_staff, v1.id, { content: content({ answerEn: "Check-in is from 16:00 to 23:00." }) });
    expect(v2.version).toBe(2);
    expect(v2.entry_key).toBe(v1.entry_key);
    expect(v2.status).toBe("draft");
    // Đang có bản mở ⇒ không tạo thêm v3.
    await expectCode(reviseQaEntry(f.actors.vn_staff, v1.id, { content: content() }), "qa_open_version_exists");

    // Trong lúc v2 là nháp, bot vẫn dùng v1.
    expect((await ask(f, "what time is check in"))?.version).toBe(1);

    await submitQaForReview(f.actors.vn_staff, v2.id);
    await approveQaEntry(f.actors.bp_coordinator, v2.id);
    const rows = await query<{ version: number; status: string }>("SELECT version, status FROM qa_entries WHERE org_id = $1 AND entry_key = $2 ORDER BY version", [f.orgId, v1.entry_key]);
    expect(rows).toEqual([
      { version: 1, status: "retired" },
      { version: 2, status: "approved" },
    ]);
    const hit = await ask(f, "what time is check in");
    expect(hit?.version).toBe(2);
    expect(hit?.answer).toContain("16:00");

    const history = await qaEntryHistory(f.actors.manager_viewer, v2.id);
    expect(history?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(history?.events.map((e) => e.action)).toEqual(expect.arrayContaining(["qa.create", "qa.revise", "qa.submit", "qa.approve", "qa.retire"]));
  });

  it("người tạo không tự duyệt; chỉ duyệt bản chờ duyệt; từ chối cần lý do và trả về nháp", async () => {
    const f = await makeFixture();
    const draft = await createQaDraft(f.actors.vn_manager, content());
    await expectCode(approveQaEntry(f.actors.bp_coordinator, draft.id), "qa_bad_status");
    await submitQaForReview(f.actors.vn_manager, draft.id);
    await expectCode(approveQaEntry(f.actors.vn_manager, draft.id), "self_approval");
    // Người không có quyền duyệt
    await expectCode(approveQaEntry(f.actors.vn_staff, draft.id), "forbidden");
    await expectInvalid(rejectQaEntry(f.actors.bp_coordinator, draft.id, { reason: "" }), "Cần ghi lý do");
    const rejected = await rejectQaEntry(f.actors.bp_coordinator, draft.id, { reason: "Thiếu giờ nhận muộn" });
    expect(rejected.status).toBe("draft");

    // Người khác sửa nội dung ⇒ thành người soạn, không tự duyệt được nữa; người tạo ban đầu duyệt được.
    const edited = await updateQaDraft(f.actors.bp_coordinator, draft.id, { expectedUpdatedAt: new Date(rejected.updated_at).toISOString(), content: content({ answerEn: "Check-in 15:00–23:00." }) });
    await expectCode(updateQaDraft(f.actors.vn_staff, draft.id, { expectedUpdatedAt: new Date(rejected.updated_at).toISOString(), content: content() }), "stale_version");
    await submitQaForReview(f.actors.bp_coordinator, edited.id);
    await expectCode(approveQaEntry(f.actors.bp_coordinator, draft.id), "self_approval");
    const ok = await approveQaEntry(f.actors.vn_manager, draft.id);
    expect(ok.status).toBe("approved");
    expect(ok.approved_by).toBe(f.actors.vn_manager.userId);
  });

  it("chặn lưu mã cửa/mật khẩu (422) nhưng cho câu nói mật khẩu dán trong phòng", async () => {
    const f = await makeFixture();
    for (const answerEn of ["Door code: 4821", "The PIN is 1234#", "wifi password: sunflower77", "Passcode 9911"]) {
      const err = await expectCode(createQaDraft(f.actors.vn_staff, content({ answerEn })), "secret_content");
      expect(err.message).toContain("Không lưu mã cửa/mật khẩu");
    }
    await expectCode(createQaDraft(f.actors.vn_staff, content({ answerVi: "Mã cửa là 1234" })), "secret_content");
    await expectCode(createQaDraft(f.actors.vn_staff, content({ variants: ["jelszó: abc123"] })), "secret_content");
    const ok = await createQaDraft(f.actors.vn_staff, content({ topic: "wifi", question: "Is there Wi-Fi?", answerEn: "Yes. The Wi-Fi password is posted inside the room." }));
    expect(ok.status).toBe("draft");
    expect(looksLikeSecret("Check-in 15:00–23:00, check-out 10:00")).toBe(false);
    const rows = await query("SELECT 1 FROM qa_entries WHERE org_id = $1 AND answer_en ILIKE '%4821%'", [f.orgId]);
    expect(rows).toHaveLength(0);
  });

  it("phạm vi khớp CHECK: phòng/nhà phải thuộc tổ chức; ngưng bản đã duyệt cần quyền duyệt", async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    await expectInvalid(createQaDraft(f.actors.vn_staff, content({ scope: "unit" })), "cần chọn phòng");
    await expectInvalid(createQaDraft(f.actors.vn_staff, content({ answerEn: "" })), "tiếng Anh");
    await expectInvalid(createQaDraft(f.actors.vn_staff, content({ sensitivity: "handoff" })), "điều kiện chuyển người");
    await expectCode(createQaDraft(f.actors.vn_staff, content({ scope: "unit", unitId: other.units.r1 })), "invalid_input");
    const unitDraft = await createQaDraft(f.actors.vn_staff, content({ scope: "unit", unitId: f.units.r1, propertyId: other.propertyId }));
    expect(unitDraft.unit_id).toBe(f.units.r1);
    expect(unitDraft.property_id).toBe(f.propertyId);

    const a = await approved(f);
    await expectCode(retireQaEntry(f.actors.vn_staff, a.id, { reason: "hết dùng" }), "forbidden");
    const retired = await retireQaEntry(f.actors.vn_manager, a.id, { reason: "Đổi giờ nhận phòng" });
    expect(retired.status).toBe("retired");
    expect(await ask(f, "what time is check in")).toBeNull();
  });
});

describe("Kho Q&A — tra cứu có căn cứ", () => {
  it("ưu tiên phòng > nhà > chung; phòng khác vẫn nhận câu chung", async () => {
    const f = await makeFixture();
    await approved(f, { answerEn: "General: 15:00–23:00." });
    await approved(f, { scope: "property", propertyId: f.propertyId, answerEn: "Property: 14:00–23:00." });
    await approved(f, { scope: "unit", unitId: f.units.r1, answerEn: "Unit R1: 16:00–23:00." });

    const unitHit = await ask(f, "Hi, what time can I check in?", { unitId: f.units.r1 });
    expect(unitHit?.scope).toBe("unit");
    expect(unitHit?.answer).toContain("R1");
    expect(unitHit!.score).toBeGreaterThan(0.5);
    expect(unitHit!.score).toBeLessThanOrEqual(1);

    expect((await ask(f, "what time can I check in", { unitId: f.units.r2 }))?.scope).toBe("property");
    expect((await ask(f, "mấy giờ nhận phòng", { propertyId: f.propertyId }))?.scope).toBe("property");
    expect((await ask(f, "check in time?"))?.scope).toBe("general");
    // Không liên quan ⇒ không đoán.
    expect(await ask(f, "Where is the nearest supermarket?", { unitId: f.units.r1 })).toBeNull();
  });

  it("restricted khi chưa xác minh ⇒ null; handoff vẫn trả để bên gọi chuyển người; hết hiệu lực ⇒ null", async () => {
    const f = await makeFixture();
    await approved(f, { topic: "luggage", question: "Can I leave my luggage?", variants: ["luggage storage"], answerEn: "Luggage can be left in the storage room.", sensitivity: "restricted" });
    expect(await ask(f, "can I leave my luggage")).toBeNull();
    expect((await ask(f, "can I leave my luggage", { verification: "matched" }))?.sensitivity).toBe("restricted");

    await approved(f, { topic: "parking", question: "Is there parking?", variants: ["Có chỗ đỗ xe không?"], answerEn: "Please ask our team.", sensitivity: "handoff", handoffCondition: "Chưa có dữ liệu đỗ xe" });
    expect((await ask(f, "có chỗ đỗ xe không"))?.sensitivity).toBe("handoff");

    await approved(f, { topic: "breakfast", question: "Is breakfast included?", answerEn: "Breakfast promo.", validFrom: "2026-09-01", validTo: "2026-09-30" });
    expect((await ask(f, "is breakfast included", { opsDate: "2026-09-30" }))?.topic).toBe("breakfast");
    expect(await ask(f, "is breakfast included", { opsDate: "2026-10-01" })).toBeNull();
    await approved(f, { topic: "sauna", question: "Is the sauna open?", answerEn: "From October.", validFrom: "2026-10-02" });
    expect(await ask(f, "is the sauna open", { opsDate: "2026-10-01" })).toBeNull();

    // Nháp / chờ duyệt không bao giờ được trả.
    const d = await createQaDraft(f.actors.vn_staff, content({ topic: "towels", question: "Are towels provided?", answerEn: "Yes." }));
    expect(await ask(f, "are towels provided")).toBeNull();
    await submitQaForReview(f.actors.vn_staff, d.id);
    expect(await ask(f, "are towels provided")).toBeNull();
  });

  it("khác tổ chức không thấy: tra cứu, danh sách, lịch sử, thao tác", async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const a = await approved(f);
    expect(await findGroundedAnswer({ orgId: other.orgId, text: "what time is check in", verification: "verified", opsDate: OPS })).toBeNull();
    // Truyền phòng của tổ chức khác cũng không lấy được mục theo phòng.
    await approved(f, { scope: "unit", unitId: f.units.r1, answerEn: "Unit only." });
    expect((await findGroundedAnswer({ orgId: other.orgId, unitId: f.units.r1, text: "what time is check in", verification: "verified", opsDate: OPS }))).toBeNull();

    const list = await listQaEntries(other.actors.admin, { scope: null, propertyId: null, unitId: null, status: "all", topic: null, q: null }, { page: 1, pageSize: 50, offset: 0 });
    expect(list.total).toBe(0);
    expect(await qaEntryHistory(other.actors.admin, a.id)).toBeNull();
    await expectCode(retireQaEntry(other.actors.admin, a.id, { reason: "thử cách ly" }), "not_found");
    await expectCode(reviseQaEntry(other.actors.admin, a.id, { content: content() }), "not_found");
    // Tham số rác không làm lỗi SQL.
    expect(await findGroundedAnswer({ orgId: "khong-phai-uuid", text: "check in", verification: "none", opsDate: OPS })).toBeNull();
    expect(await ask(f, "what time is check in", { unitId: "rac", opsDate: OPS })).not.toBeNull();
  });
});
