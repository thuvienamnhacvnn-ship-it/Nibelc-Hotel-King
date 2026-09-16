import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { setClock } from "@/lib/time";
import { type Actor, systemActor, userActor } from "@/modules/auth/actor";
import { createBooking } from "@/modules/booking/service";
import { buildLookup, createAliasesFromUnitNames } from "@/modules/imports/aliases";
import { ISSUE_DEFS, normalizeUnitAlias, parseBookingWorkbook } from "@/modules/imports/excel";
import { getImportBatch, listImportRows } from "@/modules/imports/queries";
import { applyImport, previewImport } from "@/modules/imports/service";
import { expectCode, makeFixture, uid } from "./helpers";

const FIXTURE = path.join(process.cwd(), "fixtures", "demo-lich-dat-phong.xlsx");
const fixture = () => fs.readFileSync(FIXTURE);

/** Hàng TH: STT n nằm ở dòng Excel n + 2 */
const thRow = (n: number) => n + 2;

const DEMO_UNITS = [
  { code: "A000", name: "Demo A nguyên căn", kind: "whole", capacity: 8 },
  { code: "A001", name: "Demo A — Phòng 1", kind: "room", capacity: 2 },
  { code: "A002", name: "Demo A — Phòng 2", kind: "room", capacity: 3 },
  { code: "A003", name: "Demo A — Phòng 3", kind: "room", capacity: 4 },
  { code: "B001", name: "Demo B — Phòng 1", kind: "room", capacity: 3 },
  { code: "B002", name: "Demo B — Phòng 2", kind: "room", capacity: 3 },
  { code: "B010", name: "Demo B — Studio", kind: "studio", capacity: 4 },
  { code: "C001", name: "Studio Demo C", kind: "studio", capacity: 2 },
];

afterEach(() => setClock(null));

describe("Chuẩn hoá alias tên căn/phòng", () => {
  it("gộp các cách viết của cùng một phòng", () => {
    const same = (a: string, b: string) => expect(normalizeUnitAlias(a)).toBe(normalizeUnitAlias(b));
    same("Baby Room Jozsef krt50", "Baby Room J50");
    same("Baby Room Jozsef 50", "baby room jozsef krt 50");
    same("Dream Bigs Ke3", "Dream Big Kerepesi 3");
    same("Sweet Home Room Rak59", "Sweet Home Rakoczi Ut.59");
    same("Ulloi 0 Flat", "Ulloi 0 Apartment");
    same("Clever Pirates Jozsef 68", "Clever pirate Jozsef 68");
    same("J65 Studio", "Studio Jozsef 65");
    same("Love Couple at Baross", "Love Couple Baross ");
    same("'Sweet Home J65", "József 65 Sweet Home");
    expect(normalizeUnitAlias("Baby Room J50")).toBe("baby j50");
    expect(normalizeUnitAlias("Mermaid Ke2")).not.toBe(normalizeUnitAlias("Mermaid Ke3"));
    expect(normalizeUnitAlias("Princess Ke2")).toContain("princess");
  });
});

describe("Bộ đọc Excel (thuần, không DB)", () => {
  it("nhận diện mọi ca khó của file DEMO", async () => {
    const { lookup } = buildLookup(DEMO_UNITS.map((u) => ({ ...u, unitId: null })), { fromNames: true });
    const result = await parseBookingWorkbook(fixture(), { lookup });
    const th = result.rows.filter((r) => r.sheet === "TH");
    expect(th).toHaveLength(27);
    const row = (n: number) => th.find((r) => r.rowNumber === thRow(n))!;
    const codes = (n: number) => row(n).issues.map((i) => i.code);

    // Tiêu đề dòng 2, giá trị gốc giữ theo tên cột
    expect(result.sheets.find((s) => s.name === "TH")?.headerRow).toBe(2);
    expect(row(1).raw.columns["MÃ ĐẶT PHÒNG"]).toBe(1000000001);
    expect(row(1).disposition).toBe("ready");
    expect(row(1).parsed).toMatchObject({ channel: "booking_com", externalRef: "1000000001", checkIn: "2026-10-03", checkOut: "2026-10-05", unit: { code: "A001" }, bookedDate: "2026-09-05" });
    expect(row(2).disposition).toBe("ready");
    expect(row(2).parsed.unit?.code).toBe("B001");
    expect(row(3).parsed.unit?.code).toBe("B010"); // mã ghi thẳng
    // Mã lặp sau trim: cả hai dòng, không dòng nào bị xoá
    expect(row(4).disposition).toBe("duplicate_in_file");
    expect(row(5).disposition).toBe("duplicate_in_file");
    expect(codes(6)).toContain("missing_ref");
    expect(codes(7)).toContain("unit_moved");
    expect(codes(8)).toContain("unit_multiple");
    expect(row(8).parsed.unitParts.map((p) => p.unitCode)).toEqual(["B001", "B002"]);
    expect(codes(9)).toContain("unit_multiple");
    expect(codes(10)).toContain("booked_date_cell_ambiguous");
    expect(row(10).disposition).toBe("ready"); // chỉ cảnh báo
    expect(row(10).parsed.bookedDate).toBe("2026-03-04"); // không tự đảo
    expect(codes(11)).toEqual(expect.arrayContaining(["note_payment", "channel_unknown", "house_sheet_mismatch"]));
    expect(row(11).parsed.paymentNote).toBe("20e TM");
    expect(codes(12)).toContain("status_conflict");
    expect(codes(13)).toContain("unit_unmapped");
    expect(codes(14)).toContain("nights_mismatch");
    expect(codes(15)).toContain("capacity_exceeded");
    expect(codes(16)).toContain("stay_date_invalid");
    expect(row(17).disposition).toBe("ready");
    expect(row(18).parsed.bookedDate).toBe("2025-10-01");
    expect(codes(19)).toContain("no_show_mentioned");
    expect(codes(20)).toContain("ref_channel_mismatch");
    expect(codes(21)).toEqual(expect.arrayContaining(["guest_missing", "unit_missing", "booked_date_missing"]));
    expect(codes(22)).toEqual(expect.arrayContaining(["booked_date_invalid", "guests_invalid"]));
    expect(codes(23)).toContain("stay_date_order");
    expect(codes(24)).toContain("stay_too_long");
    expect(codes(25)).toContain("stay_date_ambiguous");
    expect(codes(26)).toContain("booked_after_checkin");
    expect(codes(27)).toContain("room_type_mismatch");

    // Sheet nhà chỉ đối chiếu: dòng trùng TH không vào lô, mã chỉ có ở sheet nhà vào dạng skipped
    const house = result.sheets.find((s) => s.name === "Demo A")!;
    expect(house.reconciliation).toEqual({ withRef: 3, noRef: 0, matched: 1, mismatched: 1, onlyInHouse: 1 });
    const houseRows = result.rows.filter((r) => r.sheet === "Demo A");
    expect(houseRows).toHaveLength(1);
    expect(houseRows[0].disposition).toBe("skipped");
    // Sheet Hủy: tiêu đề dòng 1, mọi dòng vào hàng kiểm tra
    const cancel = result.rows.filter((r) => r.sheet === "Hủy");
    expect(result.sheets.find((s) => s.name === "Hủy")?.headerRow).toBe(1);
    expect(cancel).toHaveLength(2);
    expect(cancel.every((r) => r.disposition === "needs_review")).toBe(true);
    expect(cancel[0].issues.map((i) => i.code)).toEqual(expect.arrayContaining(["cancel_sheet", "also_in_source_sheet", "no_show_mentioned"]));
    expect(cancel[1].issues.map((i) => i.code)).toContain("cancel_mentioned");
    expect(result.sheets.find((s) => s.name === "DS Phòng")?.role).toBe("other");

    // Mọi mã lý do ở mức phân tích file đều được fixture phủ (các mã còn lại chỉ phát sinh khi đối chiếu DB / áp dụng)
    const seen = new Set(result.rows.flatMap((r) => r.issues.map((i) => i.code)));
    const dbOnly = ["ref_exists_other_channel", "past_stay_skipped", "apply_error"];
    for (const code of Object.keys(ISSUE_DEFS).filter((c) => !dbOnly.includes(c))) expect(seen, `thiếu mã ${code}`).toContain(code);
  });
});

// ───────────────────────── Có database ─────────────────────────

async function makeDemoCatalogOrg() {
  const f = await makeFixture(); // tổ chức thử riêng + các actor theo vai trò
  const orgId = f.orgId;
  const s = uid();
  const prop = async (code: string) => (await queryOne<{ id: string }>("INSERT INTO properties (org_id, code, name) VALUES ($1,$2,$2) RETURNING id", [orgId, `${code}-${s}`]))!.id;
  const res = async (propertyId: string, code: string) =>
    (await queryOne<{ id: string }>("INSERT INTO resources (org_id, property_id, code, name) VALUES ($1,$2,$3,$3) RETURNING id", [orgId, propertyId, `R${code}-${s}`]))!.id;
  const pA = await prop("DA");
  const pB = await prop("DB");
  const pC = await prop("DC");
  const r: Record<string, string> = {};
  for (const c of ["A001", "A002", "A003"]) r[c] = await res(pA, c);
  for (const c of ["B001", "B002", "B010"]) r[c] = await res(pB, c);
  r.C001 = await res(pC, "C001");
  const propOf = (code: string) => (code.startsWith("A") ? pA : code.startsWith("B") ? pB : pC);
  const units: Record<string, string> = {};
  for (const u of DEMO_UNITS) {
    const id = (await queryOne<{ id: string }>("INSERT INTO units (org_id, property_id, code, name, kind, capacity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [orgId, propOf(u.code), u.code, u.name, u.kind, u.capacity]))!.id;
    units[u.code] = id;
    const resIds = u.code === "A000" ? [r.A001, r.A002, r.A003] : [r[u.code]];
    for (const rid of resIds) await query("INSERT INTO unit_resources (unit_id, resource_id, org_id) VALUES ($1,$2,$3)", [id, rid, orgId]);
  }
  return { ...f, demoUnits: units };
}

describe("Nhập Excel vào database", () => {
  let ctx: Awaited<ReturnType<typeof makeDemoCatalogOrg>>;
  beforeAll(async () => {
    ctx = await makeDemoCatalogOrg();
    const aliases = await createAliasesFromUnitNames(ctx.actors.admin);
    expect(aliases.created.length).toBeGreaterThanOrEqual(DEMO_UNITS.length);
    expect(aliases.collisions).toEqual([]);
  });

  it("xem trước lưu lô + dòng; người chỉ có quyền xem trước không áp dụng được; ẩn liên hệ khách khi thiếu quyền", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    const preview = await previewImport(ctx.actors.vn_staff, { fileName: "demo-lich-dat-phong.xlsx", data: fixture() });
    expect(preview.stats.byDisposition.ready).toBeGreaterThan(0);
    const stored = await query<{ n: number }>("SELECT count(*)::int AS n FROM import_rows WHERE batch_id = $1 AND org_id = $2", [preview.batchId, ctx.orgId]);
    expect(stored[0].n).toBe(preview.stats.total);
    await expectCode(applyImport(ctx.actors.vn_staff, preview.batchId), "forbidden");
    await expectCode(previewImport(ctx.actors.bp_staff, { fileName: "x.xlsx", data: fixture() }), "forbidden");

    const viewer: Actor = systemActor(ctx.orgId, "user", ["import.preview"]);
    const page = { page: 1, pageSize: 200, offset: 0 };
    const hidden = await listImportRows(viewer, preview.batchId, {}, page);
    const first = hidden.items.find((r) => r.sheet === "TH" && r.row_number === thRow(1))!;
    expect(first.raw.columns["KHÁCH"]).toBe("[ẩn]");
    expect(first.raw.columns["SĐT"]).toBe("[ẩn]");
    expect(first.parsed?.guestName).toBe("[ẩn]");
    const visible = await listImportRows(ctx.actors.vn_staff, preview.batchId, { issue: "unit_moved" }, page);
    expect(visible.items.map((r) => r.row_number)).toContain(thRow(7));
    expect(visible.items.every((r) => r.issues.some((i) => i.code === "unit_moved"))).toBe(true);

    // Cách ly tổ chức: actor tổ chức khác không thấy lô
    const other = await makeFixture();
    expect(await getImportBatch(other.actors.admin, preview.batchId)).toBeNull();
    expect((await listImportRows(other.actors.admin, preview.batchId, {}, page)).total).toBe(0);
    await expectCode(applyImport(other.actors.vn_manager, preview.batchId), "not_found");
  });

  it("áp dụng tạo booking đúng, dòng trùng tồn thành lỗi, file đã áp dụng bị chặn", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    const manager = ctx.actors.vn_manager;
    const file = { fileName: "demo-lich-dat-phong.xlsx", data: fixture() };
    const first = await previewImport(manager, file);
    const second = await previewImport(manager, file); // xem trước lần hai (chưa áp dụng) vẫn được

    const result = await applyImport(manager, first.batchId, { skipCheckOutBefore: "2026-09-16" });
    expect(result.errors).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(first.stats.byDisposition.ready - 2);

    const rows = await query<{ row_number: number; sheet: string; disposition: string; issues: { code: string; detail?: { code?: string } }[]; booking_id: string | null }>(
      "SELECT row_number, sheet, disposition, issues, booking_id FROM import_rows WHERE batch_id = $1",
      [first.batchId],
    );
    const at = (n: number) => rows.find((r) => r.sheet === "TH" && r.row_number === thRow(n))!;
    expect(at(1).disposition).toBe("applied");
    // A000 (nguyên căn) trùng đêm với A001 ở dòng 1 → lỗi tồn, không dừng cả lô
    expect(at(17).disposition).toBe("error");
    expect(at(17).issues.find((i) => i.code === "apply_error")?.detail?.code).toBe("inventory_conflict");
    expect(at(18).disposition).toBe("skipped");
    expect(at(18).issues.map((i) => i.code)).toContain("past_stay_skipped");
    expect(at(4).disposition).toBe("duplicate_in_file");
    expect(at(4).booking_id).toBeNull();

    const booking = await queryOne<{ source_channel: string; external_ref: string; stay_status: string; booking_status: string; total_guests: number; unit_code: string; created_by: string; booking_created_at: Date | null }>(
      `SELECT b.source_channel, b.external_ref, b.stay_status, b.booking_status, b.total_guests, u.code AS unit_code, b.created_by, b.booking_created_at
         FROM bookings b JOIN booking_allocations a ON a.booking_id = b.id JOIN units u ON u.id = a.unit_id WHERE b.id = $1`,
      [at(1).booking_id],
    );
    expect(booking).toMatchObject({ source_channel: "booking_com", external_ref: "1000000001", stay_status: "expected", booking_status: "confirmed", total_guests: 2, unit_code: "A001", created_by: manager.userId });
    expect(booking?.booking_created_at).not.toBeNull();
    const ambiguous = await queryOne<{ booking_created_at: Date | null }>("SELECT b.booking_created_at FROM bookings b JOIN import_rows r ON r.booking_id = b.id WHERE r.batch_id = $1 AND r.row_number = $2", [first.batchId, thRow(10)]);
    expect(ambiguous?.booking_created_at).toBeNull(); // ô Date mơ hồ không được dùng làm ngày tạo
    const history = await queryOne<{ actor_type: string; source: string }>("SELECT actor_type, source FROM booking_changes WHERE booking_id = $1 AND change_type = 'imported'", [at(1).booking_id]);
    expect(history).toEqual({ actor_type: "import", source: "excel" });
    const bookingCount = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM bookings WHERE org_id = $1", [ctx.orgId]);
    expect(bookingCount?.n).toBe(result.applied);

    // Nhập lặp cùng file: xem trước bị chặn, lô xem trước khác của cùng file bị chặn, áp dụng lại lô cũ bị chặn
    await expectCode(previewImport(manager, file), "file_already_applied");
    await expectCode(applyImport(manager, second.batchId), "file_already_applied");
    await expectCode(applyImport(manager, first.batchId), "batch_already_applied");
    expect((await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM bookings WHERE org_id = $1", [ctx.orgId]))?.n).toBe(result.applied);

    // File khác nội dung nhưng cùng mã: dòng đã nhập → already_imported; mã có ở kênh khác → cảnh báo
    await createBooking(manager, { sourceChannel: "booking_com", externalRef: "HMDEMO0013", guest: { fullName: "Khách Demo thủ công" }, checkInDate: "2027-03-01", checkOutDate: "2027-03-02", allocations: [{ unitId: ctx.demoUnits.C001 }] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fixture() as unknown as ArrayBuffer);
    wb.getWorksheet("TH")!.getCell("A1").value = "DANH SÁCH LỊCH ĐẶT PHÒNG (DEMO — bản sửa)";
    const changed = Buffer.from(await wb.xlsx.writeBuffer());
    const third = await previewImport(manager, { fileName: "demo-ban-sua.xlsx", data: changed });
    const thirdRows = await listImportRows(manager, third.batchId, { sheet: "TH" }, { page: 1, pageSize: 100, offset: 0 });
    const r3 = (n: number) => thirdRows.items.find((r) => r.row_number === thRow(n))!;
    expect(r3(1).disposition).toBe("already_imported");
    expect(r3(13).issues.map((i) => i.code)).toContain("ref_exists_other_channel");
    expect(r3(17).disposition).toBe("ready"); // lần trước lỗi tồn, chưa có booking
    const again = await applyImport(manager, third.batchId, { skipCheckOutBefore: "2026-09-16" });
    expect(again.applied).toBe(0);
    expect(again.errors).toBe(1);
  });
});
