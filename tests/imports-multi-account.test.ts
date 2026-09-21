import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { setClock } from "@/lib/time";
import { createBooking } from "@/modules/booking/service";
import { createAliasesFromUnitNames } from "@/modules/imports/aliases";
import { listImportRows } from "@/modules/imports/queries";
import { applyImport, previewImport } from "@/modules/imports/service";
import { type Fixture, expectCode, makeFixture, uid } from "./helpers";

/**
 * Công ty có nhiều tài khoản trên cùng một kênh (5 tài khoản Airbnb/Booking.com).
 * Hai tài khoản khác nhau CÓ THỂ cấp cùng một mã đặt phòng cho hai đơn khác nhau ⇒ khoá nguồn phải gồm tài khoản
 * (`bookings_source_uq` vốn đã tách theo tài khoản). Bộ kiểm này giữ cả hai chiều: không gộp nhầm, không nhập trùng.
 */

afterEach(() => setClock(null));

interface SheetRow {
  ref: string;
  unitCode: string;
  guest: string;
  checkIn: string;
  checkOut: string;
  guests?: number;
}

const HEADERS = ["STT", "NGÀY NHẬN BOOKING", "KHÁCH", "GHI CHÚ", "CĂN HỘ", "MÃ ĐẶT PHÒNG", "THỜI GIAN NHẬN PHÒNG", "THỜI GIAN TRẢ PHÒNG", "TỔNG SỐ KHÁCH"];

/** File .xlsx tối thiểu đúng định dạng sheet TH. `title` chỉ để đổi sha256 — mỗi lô nhập cần một file khác nội dung. */
async function makeWorkbook(title: string, rows: SheetRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("TH");
  ws.getRow(1).values = [title];
  ws.getRow(2).values = HEADERS;
  rows.forEach((r, i) => {
    ws.getRow(3 + i).values = [i + 1, "05/09/2026", r.guest, "Booking.com", r.unitCode, r.ref, r.checkIn, r.checkOut, r.guests ?? 2];
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** STT n nằm ở dòng Excel n + 2 (dòng 1 tiêu đề file, dòng 2 tiêu đề bảng). */
const thRow = (n: number) => n + 2;

const dispositionOfRow = async (batchId: string, n: number) =>
  (await queryOne<{ disposition: string }>("SELECT disposition FROM import_rows WHERE batch_id = $1 AND sheet = 'TH' AND row_number = $2", [batchId, thRow(n)]))?.disposition;

describe("Nhập Excel nhiều tài khoản OTA", () => {
  let ctx: Fixture;
  let unitCodes: Record<string, string>;
  let accounts: { a: string; b: string };
  let labels: { a: string; b: string };

  beforeAll(async () => {
    ctx = await makeFixture();
    await createAliasesFromUnitNames(ctx.actors.admin);
    const codes = await query<{ id: string; code: string }>("SELECT id, code FROM units WHERE org_id = $1", [ctx.orgId]);
    const byId = new Map(codes.map((u) => [u.id, u.code]));
    unitCodes = {
      r1: byId.get(ctx.units.r1)!,
      r2: byId.get(ctx.units.r2)!,
      r3: byId.get(ctx.units.r3)!,
      studio: byId.get(ctx.units.studio)!,
    };
    const s = uid();
    labels = { a: `BDC Nha 1 ${s}`, b: `BDC Nha 2 ${s}` };
    const conn = async (label: string) =>
      (await queryOne<{ id: string }>("INSERT INTO connector_accounts (org_id, channel, label, status) VALUES ($1,'booking_com',$2,'not_configured') RETURNING id", [ctx.orgId, label]))!.id;
    accounts = { a: await conn(labels.a), b: await conn(labels.b) };
  });

  it("hai tài khoản trên cùng kênh: cùng mã đặt phòng ⇒ hai booking riêng, không cái nào bị đánh đã nhập", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    // Hai đơn THẬT khác nhau (khác phòng, khác ngày) chỉ tình cờ trùng mã — đúng tình huống làm mất đơn trước đây.
    const fileA = await makeWorkbook("Lô tài khoản 1", [{ ref: "9001", unitCode: unitCodes.r1, guest: "Khách tài khoản 1", checkIn: "3 tháng 10 2026", checkOut: "5 tháng 10 2026" }]);
    const fileB = await makeWorkbook("Lô tài khoản 2", [{ ref: "9001", unitCode: unitCodes.r2, guest: "Khách tài khoản 2", checkIn: "3 tháng 11 2026", checkOut: "5 tháng 11 2026" }]);

    const previewA = await previewImport(ctx.actors.vn_manager, { fileName: "tk1.xlsx", data: fileA }, { connectorId: accounts.a });
    expect(previewA.sourceAccount).toBe(labels.a);
    const resultA = await applyImport(ctx.actors.vn_manager, previewA.batchId);
    expect(resultA).toMatchObject({ applied: 1, alreadyImported: 0, errors: 0 });

    // Lô thứ hai thấy mã đã tồn tại nhưng ở tài khoản khác ⇒ chỉ cảnh báo, vẫn hợp lệ để nhập.
    const previewB = await previewImport(ctx.actors.vn_manager, { fileName: "tk2.xlsx", data: fileB }, { connectorId: accounts.b });
    const rowB = (await listImportRows(ctx.actors.vn_manager, previewB.batchId, {}, { page: 1, pageSize: 10, offset: 0 })).items[0];
    expect(rowB.disposition).toBe("ready");
    expect(rowB.issues.map((i) => i.code)).toContain("ref_exists_other_account");
    const resultB = await applyImport(ctx.actors.vn_manager, previewB.batchId);
    expect(resultB).toMatchObject({ applied: 1, alreadyImported: 0, errors: 0 });

    const bookings = await query<{ source_account: string; guest_name: string }>(
      "SELECT b.source_account, g.full_name AS guest_name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.org_id = $1 AND b.external_ref = '9001' ORDER BY b.source_account",
      [ctx.orgId],
    );
    expect(bookings.map((b) => b.source_account)).toEqual([labels.a, labels.b]);
    expect(bookings.map((b) => b.guest_name)).toEqual(["Khách tài khoản 1", "Khách tài khoản 2"]);
  });

  it("cùng tài khoản, cùng mã ⇒ vẫn đánh đã nhập và không tạo booking thứ hai", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    const file = await makeWorkbook("Lô tài khoản 1 — đợt sau", [
      { ref: "9001", unitCode: unitCodes.r3, guest: "Khách tài khoản 1 (gửi lại)", checkIn: "3 tháng 12 2026", checkOut: "5 tháng 12 2026" },
      { ref: "9002", unitCode: unitCodes.studio, guest: "Khách mới", checkIn: "3 tháng 12 2026", checkOut: "5 tháng 12 2026" },
    ]);
    const preview = await previewImport(ctx.actors.vn_manager, { fileName: "tk1-lai.xlsx", data: file }, { connectorId: accounts.a });
    // Mã 9001 đã có ở CHÍNH tài khoản này ⇒ chặn ngay từ bước xem trước.
    expect(await dispositionOfRow(preview.batchId, 1)).toBe("already_imported");
    const result = await applyImport(ctx.actors.vn_manager, preview.batchId);
    expect(result).toMatchObject({ applied: 1, errors: 0 });
    expect(await dispositionOfRow(preview.batchId, 2)).toBe("applied");
    const n = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM bookings WHERE org_id = $1 AND external_ref = '9001' AND source_account = $2", [ctx.orgId, labels.a]);
    expect(n?.n).toBe(1);
  });

  it("hai lô song song cùng tài khoản cùng mã: chỉ một booking được tạo, lô kia thành đã nhập", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    // Hai file khác nội dung ⇒ không dính khoá theo sha256 của lô; cả hai cùng 'ready' vì lúc xem trước chưa có booking nào.
    const one = await makeWorkbook("Song song 1", [{ ref: "9500", unitCode: unitCodes.r1, guest: "Khách song song 1", checkIn: "3 tháng 6 2027", checkOut: "5 tháng 6 2027" }]);
    const two = await makeWorkbook("Song song 2", [{ ref: "9500", unitCode: unitCodes.r2, guest: "Khách song song 2", checkIn: "3 tháng 7 2027", checkOut: "5 tháng 7 2027" }]);
    const pOne = await previewImport(ctx.actors.vn_manager, { fileName: "ss1.xlsx", data: one }, { connectorId: accounts.a });
    const pTwo = await previewImport(ctx.actors.vn_manager, { fileName: "ss2.xlsx", data: two }, { connectorId: accounts.a });
    expect(await dispositionOfRow(pOne.batchId, 1)).toBe("ready");
    expect(await dispositionOfRow(pTwo.batchId, 1)).toBe("ready");

    // Hai lượt áp dụng chạy chồng nhau. Khoá tư vấn org|kênh|tài khoản|mã + kiểm trước khi ghi bảo đảm chỉ một dòng
    // tạo booking. (Cầu nối PGlite của bộ kiểm thử xếp hàng theo giao dịch nên ở đây khoá không phải chờ thật —
    // cái được kiểm là kết quả: một booking, dòng còn lại 'already_imported'.)
    const [first, second] = await Promise.all([applyImport(ctx.actors.vn_manager, pOne.batchId), applyImport(ctx.actors.vn_manager, pTwo.batchId)]);
    expect(first.applied + second.applied).toBe(1);
    expect(first.alreadyImported + second.alreadyImported).toBe(1);
    expect(first.errors + second.errors).toBe(0);
    const bookings = await query<{ id: string }>("SELECT id FROM bookings WHERE org_id = $1 AND external_ref = '9500'", [ctx.orgId]);
    expect(bookings).toHaveLength(1);
  });

  it("nhiều tài khoản cùng kênh mà không chọn tài khoản ⇒ từ chối, không lưu lô nào", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    const file = await makeWorkbook("Thiếu tài khoản", [{ ref: "9600", unitCode: unitCodes.r1, guest: "Khách thiếu tài khoản", checkIn: "3 tháng 8 2027", checkOut: "5 tháng 8 2027" }]);
    const before = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM import_batches WHERE org_id = $1", [ctx.orgId]);
    await expectCode(previewImport(ctx.actors.vn_manager, { fileName: "thieu.xlsx", data: file }), "source_account_required");
    await expectCode(previewImport(ctx.actors.vn_manager, { fileName: "thieu.xlsx", data: file }, { connectorId: "00000000-0000-4000-8000-000000000000" }), "not_found");
    // Nhãn gõ tay phải là tài khoản CÓ THẬT: nhãn lạ và nhãn thừa dấu cách đều bị từ chối, không tự mở namespace mới.
    await expectCode(previewImport(ctx.actors.vn_manager, { fileName: "thieu.xlsx", data: file }, { sourceAccount: "Tài khoản không hề tồn tại" }), "not_found");
    await expectCode(previewImport(ctx.actors.vn_manager, { fileName: "thieu.xlsx", data: file }, { sourceAccount: labels.a.replace(" ", "  ") }), "not_found");
    const after = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM import_batches WHERE org_id = $1", [ctx.orgId]);
    expect(after?.n).toBe(before?.n);
  });

  it("kịch bản QA: đơn cũ ghi '' + lô mới có nhãn + khách ĐỔI NGÀY ⇒ vẫn chỉ MỘT booking", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    // Giai đoạn 1 — như toàn bộ dữ liệu production: lúc nhập chưa có ô chọn tài khoản ⇒ source_account = ''.
    const old = await makeFixture();
    await createAliasesFromUnitNames(old.actors.admin);
    const code = (await queryOne<{ code: string }>("SELECT code FROM units WHERE id = $1", [old.units.r1]))!.code;
    const codeR2 = (await queryOne<{ code: string }>("SELECT code FROM units WHERE id = $1", [old.units.r2]))!.code;
    const before = await makeWorkbook("Bản xuất tháng trước", [{ ref: "7001", unitCode: code, guest: "Khách đổi ngày", checkIn: "3 tháng 10 2026", checkOut: "5 tháng 10 2026" }]);
    const p1 = await previewImport(old.actors.vn_manager, { fileName: "thang-truoc.xlsx", data: before });
    expect(p1.sourceAccount).toBe("");
    expect(await applyImport(old.actors.vn_manager, p1.batchId)).toMatchObject({ applied: 1, errors: 0 });

    // Giai đoạn 2 — công ty nối thêm tài khoản OTA thứ hai, từ nay lô nhập buộc phải chọn tài khoản.
    const s = uid();
    const conn = async (label: string) =>
      (await queryOne<{ id: string }>("INSERT INTO connector_accounts (org_id, channel, label, status) VALUES ($1,'booking_com',$2,'not_configured') RETURNING id", [old.orgId, label]))!.id;
    const acc1 = await conn(`BDC cu ${s}`);
    await conn(`BDC moi ${s}`);

    // Giai đoạn 3 — bản xuất tháng sau: CÙNG đơn nhưng khách đã đổi ngày (nên không đụng tồn để lộ ra).
    const after = await makeWorkbook("Bản xuất tháng sau", [
      { ref: "7001", unitCode: code, guest: "Khách đổi ngày", checkIn: "10 tháng 10 2026", checkOut: "13 tháng 10 2026" },
      { ref: "7002", unitCode: codeR2, guest: "Khách mới tháng sau", checkIn: "3 tháng 10 2026", checkOut: "5 tháng 10 2026" },
    ]);
    const p2 = await previewImport(old.actors.vn_manager, { fileName: "thang-sau.xlsx", data: after }, { connectorId: acc1 });
    expect(await dispositionOfRow(p2.batchId, 1)).toBe("already_imported");
    const run = await applyImport(old.actors.vn_manager, p2.batchId);
    expect(run).toMatchObject({ applied: 1, errors: 0 });

    const rows = await query<{ check_in_date: string; source_account: string }>("SELECT check_in_date, source_account FROM bookings WHERE org_id = $1 AND external_ref = '7001'", [old.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ check_in_date: "2026-10-03", source_account: "" });
    // Một đơn thật ⇒ một khoảng giữ tồn, không phải hai.
    const holds = await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM booking_allocations a JOIN bookings b ON b.id = a.booking_id WHERE b.org_id = $1 AND b.external_ref = '7001' AND a.status = 'active'",
      [old.orgId],
    );
    expect(holds?.n).toBe(1);
  });

  it("đơn cũ ghi '' xuất hiện SAU bước xem trước ⇒ bước áp dụng vẫn chặn", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    const org = await makeFixture();
    await createAliasesFromUnitNames(org.actors.admin);
    const code = (await queryOne<{ code: string }>("SELECT code FROM units WHERE id = $1", [org.units.r1]))!.code;
    const s = uid();
    const acc = (await queryOne<{ id: string }>("INSERT INTO connector_accounts (org_id, channel, label, status) VALUES ($1,'booking_com',$2,'not_configured') RETURNING id", [org.orgId, `BDC ${s}`]))!.id;

    const file = await makeWorkbook("Lô có nhãn", [{ ref: "7100", unitCode: code, guest: "Khách 7100", checkIn: "3 tháng 10 2026", checkOut: "5 tháng 10 2026" }]);
    const preview = await previewImport(org.actors.vn_manager, { fileName: "co-nhan.xlsx", data: file }, { connectorId: acc });
    expect(await dispositionOfRow(preview.batchId, 1)).toBe("ready");

    // Booking đời trước (chưa biết tài khoản) được tạo sau bước xem trước, phòng/ngày khác ⇒ tồn không chặn.
    await createBooking(org.actors.vn_manager, {
      sourceChannel: "booking_com",
      sourceAccount: "",
      externalRef: "7100",
      guest: { fullName: "Khách 7100" },
      checkInDate: "2026-11-03",
      checkOutDate: "2026-11-05",
      allocations: [{ unitId: org.units.r2 }],
    });
    const run = await applyImport(org.actors.vn_manager, preview.batchId);
    expect(run).toMatchObject({ applied: 0, alreadyImported: 1, errors: 0 });
    expect((await query("SELECT id FROM bookings WHERE org_id = $1 AND external_ref = '7100'", [org.orgId]))).toHaveLength(1);
  });

  it("dữ liệu cũ (tài khoản rỗng) vẫn nhập lại được và không bị nhân bản", async () => {
    setClock(() => new Date("2026-09-16T08:00:00Z"));
    // Tổ chức riêng, KHÔNG có hai tài khoản cùng kênh ⇒ vẫn nhập được mà không cần khai tài khoản, như các lô đã có.
    const old = await makeFixture();
    await createAliasesFromUnitNames(old.actors.admin);
    const code = (await queryOne<{ code: string }>("SELECT code FROM units WHERE id = $1", [old.units.r1]))!.code;
    const file = await makeWorkbook("Lô cũ", [{ ref: "8001", unitCode: code, guest: "Khách lô cũ", checkIn: "3 tháng 10 2026", checkOut: "5 tháng 10 2026" }]);
    const preview = await previewImport(old.actors.vn_manager, { fileName: "cu.xlsx", data: file });
    expect(preview.sourceAccount).toBe("");
    expect(await applyImport(old.actors.vn_manager, preview.batchId)).toMatchObject({ applied: 1, errors: 0 });
    const created = await queryOne<{ source_account: string }>("SELECT source_account FROM bookings WHERE org_id = $1 AND external_ref = '8001'", [old.orgId]);
    expect(created?.source_account).toBe("");

    // Gửi lại cùng mã, vẫn không khai tài khoản ⇒ khớp với dòng cũ (source_account = ''), không đẻ booking thứ hai.
    const again = await makeWorkbook("Lô cũ gửi lại", [{ ref: "8001", unitCode: code, guest: "Khách lô cũ", checkIn: "3 tháng 10 2026", checkOut: "5 tháng 10 2026" }]);
    const preview2 = await previewImport(old.actors.vn_manager, { fileName: "cu-2.xlsx", data: again });
    expect(await dispositionOfRow(preview2.batchId, 1)).toBe("already_imported");
    const n = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM bookings WHERE org_id = $1 AND external_ref = '8001'", [old.orgId]);
    expect(n?.n).toBe(1);
  });
});
