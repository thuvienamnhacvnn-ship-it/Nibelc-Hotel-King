import ExcelJS from "exceljs";
import { diffDays } from "@/lib/time";
import { type CellDate, parseDmyOrCell, parseStayDate } from "./dates";
import { type Disposition, type IssueCode, type RowIssue, issue } from "./issues";
import { looseText, normalizeHeader, normalizeUnitAlias, stripBidi } from "./normalize";

/**
 * Bộ đọc thuần file "Danh sách lịch đặt phòng" — không chạm database.
 * Nhận Buffer, trả mọi dòng kèm giá trị gốc, giá trị đã hiểu, lý do kiểm tra và hướng xử lý.
 * Tra căn/phòng qua `lookup` do nơi gọi dựng (từ DB hoặc từ danh mục docx).
 */

export type Field =
  | "stt"
  | "booked"
  | "guest"
  | "note"
  | "unit"
  | "ref"
  | "check_in"
  | "check_out"
  | "nights"
  | "room_type"
  | "guests"
  | "checkin_note"
  | "status"
  | "phone";

const HEADER_FIELDS: [string, Field][] = [
  ["stt", "stt"],
  ["ngay nhan booking", "booked"],
  ["khach", "guest"],
  ["ghi chu", "note"],
  ["can ho", "unit"],
  ["ma dat phong", "ref"],
  ["thoi gian nhan phong", "check_in"],
  ["thoi gian tra phong", "check_out"],
  ["so dem", "nights"],
  ["so ngay", "nights"],
  ["loai phong", "room_type"],
  ["tong so khach", "guests"],
  ["gio check in", "checkin_note"],
  ["tinh trang", "status"],
  ["sdt", "phone"],
];

/** Cột chứa dữ liệu liên hệ khách — ẩn khi người xem thiếu quyền booking.view_guest_contact. */
export const GUEST_CONTACT_FIELDS: Field[] = ["guest", "phone"];

export function fieldOfHeader(header: string): Field | null {
  const h = normalizeHeader(header);
  return HEADER_FIELDS.find(([k]) => k === h)?.[1] ?? null;
}

export interface UnitLookupEntry {
  unitId: string | null;
  code: string;
  name: string;
  kind: string | null;
  capacity: number | null;
}
export type UnitLookup = Map<string, UnitLookupEntry>;

export interface RawRow {
  /** Tiêu đề cột gốc → giá trị gốc (ô Date ghi dạng YYYY-MM-DD và liệt kê trong dateCells). */
  columns: Record<string, string | number | null>;
  dateCells?: string[];
}

export interface UnitPart {
  text: string;
  role: "stay" | "move_to";
  alias: string;
  unitCode: string | null;
  unitId: string | null;
}

export interface ParsedFields {
  externalRef: string | null;
  channel: "airbnb" | "booking_com" | null;
  note: string | null;
  paymentNote: string | null;
  guestName: string | null;
  guestPhone: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  bookedDate: string | null;
  bookedDateSource: CellDate["source"];
  /** Ô Date ngày ≤ 12 — có thể đã bị Excel đảo; không dùng làm thời điểm tạo booking. */
  bookedDateAmbiguous: boolean;
  totalGuests: number | null;
  roomType: string | null;
  unitParts: UnitPart[];
  unit: { code: string; unitId: string | null; name: string; capacity: number | null } | null;
  checkinNote: string | null;
  statusText: string | null;
}

export interface ParsedImportRow {
  sheet: string;
  rowNumber: number;
  raw: RawRow;
  parsed: ParsedFields;
  issues: RowIssue[];
  disposition: Disposition;
  /** kênh|mã — khoá chống nhập lặp; null khi thiếu mã */
  sourceKey: string | null;
}

export type SheetRole = "source" | "house" | "cancel" | "other";

export interface SheetSummary {
  name: string;
  role: SheetRole;
  headerRow: number | null;
  dataRows: number;
  /** Chỉ với sheet nhà: đối chiếu với sheet nguồn */
  reconciliation?: { withRef: number; noRef: number; matched: number; mismatched: number; onlyInHouse: number };
}

export interface ParseOptions {
  sourceSheet?: string;
  lookup: UnitLookup;
}

export interface ParseResult {
  sourceSheet: string;
  sheets: SheetSummary[];
  rows: ParsedImportRow[];
}

// ───────────────────────── Đọc ô ─────────────────────────

type CellValue = string | number | Date | null;

function cellValue(cell: ExcelJS.Cell): CellValue {
  const v = cell.value as unknown;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join("");
    if ("result" in o) {
      const r = o.result;
      return r instanceof Date || typeof r === "number" || typeof r === "string" ? r : null;
    }
    if (typeof o.text === "string") return o.text;
    if (o.error) return null;
  }
  return null;
}

const text = (v: CellValue | undefined): string | null => {
  if (v == null) return null;
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  const t = stripBidi(s).trim();
  return t === "" ? null : t;
};

function sheetKey(name: string) {
  return normalizeHeader(name);
}

interface HeaderInfo {
  row: number;
  columns: { index: number; header: string; field: Field | null }[];
}

/** Tiêu đề ở dòng 1 hoặc 2 (dòng 1 có thể là tiêu đề gộp ô). Nhận diện theo chữ, không theo vị trí. */
function findHeader(ws: ExcelJS.Worksheet): HeaderInfo | null {
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const columns: HeaderInfo["columns"] = [];
    row.eachCell({ includeEmpty: false }, (cell, index) => {
      const t = text(cellValue(cell));
      if (t) columns.push({ index, header: t.replace(/\s+/g, " "), field: fieldOfHeader(t) });
    });
    const fields = new Set(columns.map((c) => c.field));
    if (fields.has("ref") && fields.has("check_in") && fields.has("unit")) return { row: r, columns };
  }
  return null;
}

interface SheetRow {
  rowNumber: number;
  raw: RawRow;
  values: Partial<Record<Field, CellValue>>;
}

function readRows(ws: ExcelJS.Worksheet, header: HeaderInfo): SheetRow[] {
  const out: SheetRow[] = [];
  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw: RawRow = { columns: {} };
    const values: SheetRow["values"] = {};
    let meaningful = false;
    for (const col of header.columns) {
      const v = cellValue(row.getCell(col.index));
      if (v instanceof Date) {
        raw.columns[col.header] = v.toISOString().slice(0, 10);
        (raw.dateCells ??= []).push(col.header);
      } else {
        raw.columns[col.header] = v;
      }
      if (col.field && values[col.field] === undefined) values[col.field] = v;
      if (col.field && col.field !== "stt" && text(v) != null) meaningful = true;
    }
    if (meaningful) out.push({ rowNumber: r, raw, values });
  }
  return out;
}

// ───────────────────────── Hiểu từng cột ─────────────────────────

function detectChannel(note: string | null): "airbnb" | "booking_com" | null {
  if (!note) return null;
  const s = looseText(note);
  if (/airbnb/.test(s)) return "airbnb";
  if (/booking/.test(s)) return "booking_com";
  return null;
}

/** "20e TM", "35.000ft TM", "TM 15K", "20e CK" — khoản thu, không phải kênh bán. */
function looksLikePayment(note: string): boolean {
  const s = looseText(note);
  return /\b(tm|ck|tien mat|chuyen khoan)\b/.test(s) || /\d\s*(e|eur|euro|ft|huf|k|\$|€)\b/.test(s) || /[€$]/.test(s);
}

export function splitUnitCell(value: string): { text: string; role: "stay" | "move_to"; joinedByPlus: boolean }[] {
  const parts: { text: string; role: "stay" | "move_to"; joinedByPlus: boolean }[] = [];
  for (const line of value.normalize("NFC").split(/\r?\n/)) {
    const segments = line.split("=>");
    segments.forEach((segment, i) => {
      const pieces = segment.split(/\s\+\s|\+|(?:^|\s+)và\s+/);
      for (const p of pieces) {
        const t = p.trim().replace(/^'+/, "").replace(/[,;]+$/, "").trim();
        if (t) parts.push({ text: t, role: i === 0 ? "stay" : "move_to", joinedByPlus: pieces.length > 1 });
      }
    });
  }
  return parts;
}

function toInt(v: CellValue | undefined): number | null | "invalid" {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isInteger(v) ? v : "invalid";
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  return s === "" ? null : "invalid";
}

function interpretRow(sheet: string, row: SheetRow, lookup: UnitLookup): ParsedImportRow {
  const v = row.values;
  const issues: RowIssue[] = [];
  const add = (code: IssueCode, message: string, detail?: unknown) => issues.push(issue(code, message, detail));

  const externalRef = text(v.ref);
  const note = text(v.note);
  const channel = detectChannel(note);
  let paymentNote: string | null = null;
  if (!externalRef) add("missing_ref", "Dòng không có mã đặt phòng — không thể chống nhập lặp.");
  // Khoản thu có thể đứng riêng ("20e TM") hoặc lẫn với kênh ("Booking 460,86e TM"). Thông điệp không chép số tiền —
  // người thiếu quyền doanh thu vẫn đọc được danh sách lý do.
  if (note && looksLikePayment(note)) {
    paymentNote = note;
    add("payment_note", "Cột ghi chú có khoản thu — đã tách ra ghi chú thu tiền (chưa đối soát), không đưa vào ghi chú booking.");
  }
  if (!channel) {
    add("channel_unknown", paymentNote ? "Ghi chú chỉ có khoản thu — không biết kênh bán." : note ? `Ghi chú "${note}" không cho biết kênh bán.` : "Cột ghi chú trống — không biết kênh bán.");
  }
  if (externalRef && channel) {
    const numeric = /^\d+$/.test(externalRef);
    if (channel === "booking_com" && !numeric) add("ref_channel_mismatch", "Ghi chú là Booking.com nhưng mã không phải dạng số.");
    if (channel === "airbnb" && numeric) add("ref_channel_mismatch", "Ghi chú là Airbnb nhưng mã là dạng số (giống Booking.com).");
  }

  const guestName = text(v.guest)?.replace(/\s+/g, " ") ?? null;
  if (!guestName) add("guest_missing", "Thiếu tên khách.");
  const guestPhone = text(v.phone)?.replace(/\s+/g, " ") ?? null;

  const ci = parseStayDate(v.check_in);
  const co = parseStayDate(v.check_out);
  if (!ci.date || !co.date) add("stay_date_invalid", `Không đọc được ${!ci.date ? "ngày nhận phòng" : ""}${!ci.date && !co.date ? " và " : ""}${!co.date ? "ngày trả phòng" : ""}.`);
  if (ci.ambiguous || co.ambiguous) add("stay_date_ambiguous", "Ngày ở nằm trong ô Date với ngày ≤ 12 — có thể Excel đã đảo ngày/tháng. Không tự sửa.");
  let nights: number | null = null;
  const nightsRaw = toInt(v.nights);
  if (typeof nightsRaw === "number") nights = nightsRaw;
  if (ci.date && co.date) {
    const span = diffDays(ci.date, co.date);
    if (span <= 0) add("stay_date_order", "Ngày trả phòng không sau ngày nhận phòng.");
    else if (span > 366) add("stay_too_long", `Kỳ ở ${span} đêm — kiểm tra lại năm.`);
    if (span > 0 && nights != null && nights !== span) add("nights_mismatch", `Cột số đêm ghi ${nights}, theo ngày là ${span}.`);
  }

  const booked = parseDmyOrCell(v.booked);
  if (booked.source === "empty") add("booked_date_missing", "Không có ngày nhận booking.");
  else if (!booked.date) add("booked_date_invalid", "Không đọc được ngày nhận booking.");
  if (booked.ambiguous) add("booked_date_cell_ambiguous", "Ngày nhận booking là ô Date với ngày ≤ 12 — có thể đã bị đảo ngày/tháng; giữ nguyên, không tự sửa.");
  if (booked.date && ci.date && booked.date > ci.date) add("booked_after_checkin", "Ngày nhận booking sau ngày nhận phòng.");

  let totalGuests: number | null = null;
  const g = toInt(v.guests);
  if (g === "invalid") add("guests_invalid", "Tổng số khách không phải số nguyên.");
  else totalGuests = g;

  // Căn hộ
  const unitText = text(v.unit);
  const unitParts: UnitPart[] = [];
  let unit: ParsedFields["unit"] = null;
  if (!unitText) {
    add("unit_missing", "Cột căn hộ trống.");
  } else {
    const pieces = splitUnitCell(unitText);
    for (const p of pieces) {
      const alias = normalizeUnitAlias(p.text);
      const hit = lookup.get(alias);
      unitParts.push({ text: p.text, role: p.role, alias, unitCode: hit?.code ?? null, unitId: hit?.unitId ?? null });
    }
    const stays = unitParts.filter((p) => p.role === "stay");
    const moves = unitParts.filter((p) => p.role === "move_to");
    if (moves.length) add("unit_moved", "Ô căn hộ có chuyển phòng (=>) — cần tách kỳ ở theo phòng trước khi nhập.", { parts: unitParts.map((p) => ({ text: p.text, role: p.role, unitCode: p.unitCode })) });
    if (stays.length > 1 || pieces.some((p) => p.joinedByPlus)) add("unit_multiple", `Ô căn hộ có ${stays.length} phòng — một booking nhiều phòng cần kiểm tra phân bổ.`, { parts: stays.map((p) => ({ text: p.text, unitCode: p.unitCode })) });
    const unmapped = unitParts.filter((p) => !p.unitCode);
    if (unmapped.length) add("unit_unmapped", `Chưa có alias cho: ${unmapped.map((p) => `"${p.text}"`).join(", ")}.`, { aliases: unmapped.map((p) => p.alias) });
    if (unitParts.length === 1 && unitParts[0].unitCode) {
      const hit = lookup.get(unitParts[0].alias)!;
      unit = { code: hit.code, unitId: hit.unitId, name: hit.name, capacity: hit.capacity };
      if (totalGuests != null && hit.capacity != null && totalGuests > hit.capacity) {
        add("capacity_exceeded", `${totalGuests} khách vượt sức chứa ${hit.capacity} của ${hit.code}.`);
      }
      const roomType = looseText(text(v.room_type) ?? "");
      if (/nguyen can/.test(roomType) && hit.kind === "room") add("room_type_mismatch", `Loại phòng ghi "nguyên căn" nhưng ${hit.code} là phòng lẻ.`);
      const n = /^(\d+)\s*phong/.exec(roomType);
      if (n && Number(n[1]) > 1) add("room_type_mismatch", `Loại phòng ghi ${n[1]} phòng nhưng ô căn hộ chỉ có một sản phẩm.`);
    }
  }

  // Trạng thái: chữ hủy/vắng mặt nằm lẫn ở cột giờ check-in, ghi chú hoặc tình trạng
  const checkinNote = text(v.checkin_note);
  const statusText = text(v.status);
  const blob = looseText([checkinNote, statusText, note].filter(Boolean).join(" | "));
  const cancelled = /\bhuy\b|\bcancel/.test(blob);
  const completed = /hoan tat/.test(looseText(statusText ?? ""));
  if (cancelled && completed) add("status_conflict", "Có chữ hủy nhưng tình trạng ghi \"đã hoàn tất\" — cần nguồn xác nhận (OTA), không tự chọn.");
  else if (cancelled) add("cancel_mentioned", "Ghi chú nhắc tới hủy — kiểm tra trên kênh trước khi nhập.");
  if (/vang mat|no.?show/.test(blob)) add("no_show_mentioned", "Có ghi \"vắng mặt\" — kiểm tra trên kênh.");

  const parsed: ParsedFields = {
    externalRef,
    channel,
    note,
    paymentNote,
    guestName,
    guestPhone,
    checkIn: ci.date,
    checkOut: co.date,
    nights,
    bookedDate: booked.date,
    bookedDateSource: booked.source,
    bookedDateAmbiguous: booked.ambiguous,
    totalGuests,
    roomType: text(v.room_type),
    unitParts,
    unit,
    checkinNote,
    statusText,
  };
  return {
    sheet,
    rowNumber: row.rowNumber,
    raw: row.raw,
    parsed,
    issues,
    disposition: dispositionOf(issues),
    sourceKey: externalRef ? `${channel ?? "unknown"}|${externalRef}` : null,
  };
}

export function dispositionOf(issues: RowIssue[], current?: Disposition): Disposition {
  if (current && ["applied", "error", "already_imported", "skipped"].includes(current)) return current;
  if (issues.some((i) => i.code === "duplicate_ref_in_file")) return "duplicate_in_file";
  if (issues.some((i) => i.code === "only_in_house_sheet")) return "skipped";
  if (issues.some((i) => i.severity === "block")) return "needs_review";
  return "ready";
}

// ───────────────────────── Toàn file ─────────────────────────

export async function loadWorkbook(buffer: Buffer | ArrayBuffer | Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const data = buffer instanceof ArrayBuffer ? buffer : (buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
  await wb.xlsx.load(data);
  return wb;
}

export interface SheetInspection {
  name: string;
  hasBookingHeader: boolean;
  headerRow: number | null;
  dataRows: number;
  suggestedRole: SheetRole;
}

export function isCancelSheetName(name: string): boolean {
  return sheetKey(name) === "huy";
}

function roleOf(name: string, source: string, hasHeader: boolean): SheetRole {
  // Sheet Hủy luôn là hàng kiểm tra, kể cả khi ai đó chọn nó làm nguồn.
  if (isCancelSheetName(name)) return "cancel";
  if (sheetKey(name) === sheetKey(source)) return "source";
  return hasHeader ? "house" : "other";
}

/** Liệt kê sheet để người dùng chọn sheet nguồn. */
export async function inspectWorkbook(buffer: Buffer | ArrayBuffer | Uint8Array, sourceSheet = "TH"): Promise<SheetInspection[]> {
  const wb = await loadWorkbook(buffer);
  return wb.worksheets.map((ws) => {
    const header = findHeader(ws);
    return {
      name: ws.name,
      hasBookingHeader: !!header,
      headerRow: header?.row ?? null,
      dataRows: header ? readRows(ws, header).length : 0,
      suggestedRole: roleOf(ws.name, sourceSheet, !!header),
    };
  });
}

export async function parseBookingWorkbook(buffer: Buffer | ArrayBuffer | Uint8Array, opts: ParseOptions): Promise<ParseResult> {
  const wb = await loadWorkbook(buffer);
  const wanted = opts.sourceSheet ?? "TH";
  if (isCancelSheetName(wanted)) throw new ParseError("cancel_sheet_as_source", "Không dùng sheet Hủy làm sheet nguồn — dòng Hủy chỉ vào hàng kiểm tra.");
  const sourceWs = wb.worksheets.find((ws) => sheetKey(ws.name) === sheetKey(wanted));
  if (!sourceWs) throw new ParseError("source_sheet_missing", `File không có sheet "${wanted}".`);
  const sourceHeader = findHeader(sourceWs);
  if (!sourceHeader) throw new ParseError("header_not_found", `Sheet "${sourceWs.name}" không có dòng tiêu đề booking (MÃ ĐẶT PHÒNG, THỜI GIAN NHẬN PHÒNG, CĂN HỘ).`);

  const sheets: SheetSummary[] = [];
  const rows: ParsedImportRow[] = [];

  const sourceRows = readRows(sourceWs, sourceHeader).map((r) => interpretRow(sourceWs.name, r, opts.lookup));
  sheets.push({ name: sourceWs.name, role: "source", headerRow: sourceHeader.row, dataRows: sourceRows.length });

  // Mã lặp trong sheet nguồn (sau khi bỏ khoảng trắng đầu/cuối). Không xoá dòng nào — đánh dấu tất cả để người kiểm tra chọn.
  const byRef = new Map<string, ParsedImportRow[]>();
  for (const r of sourceRows) {
    if (!r.parsed.externalRef) continue;
    const list = byRef.get(r.parsed.externalRef) ?? [];
    list.push(r);
    byRef.set(r.parsed.externalRef, list);
  }
  for (const list of byRef.values()) {
    if (list.length < 2) continue;
    for (const r of list) {
      const others = list.filter((o) => o !== r).map((o) => o.rowNumber);
      r.issues.push(issue("duplicate_ref_in_file", `Mã này còn xuất hiện ở dòng ${others.join(", ")} của sheet ${r.sheet}.`, { rows: others }));
    }
  }

  for (const ws of wb.worksheets) {
    if (ws === sourceWs) continue;
    const header = findHeader(ws);
    const role = roleOf(ws.name, wanted, !!header);
    if (!header) {
      sheets.push({ name: ws.name, role, headerRow: null, dataRows: 0 });
      continue;
    }
    const sheetRows = readRows(ws, header);
    if (role === "cancel") {
      // Sheet Hủy không đồng nhất là đã hủy (có dòng ghi "đã hoàn tất") → mọi dòng vào hàng kiểm tra.
      for (const sr of sheetRows) {
        const r = interpretRow(ws.name, sr, opts.lookup);
        r.issues.unshift(issue("cancel_sheet", "Dòng nằm ở sheet Hủy — không tự coi là booking đã hủy hay còn hiệu lực."));
        if (r.parsed.externalRef && byRef.has(r.parsed.externalRef)) {
          r.issues.push(issue("also_in_source_sheet", `Mã cũng có ở sheet ${sourceWs.name} dòng ${byRef.get(r.parsed.externalRef)!.map((x) => x.rowNumber).join(", ")}.`));
          // Dòng sheet nguồn cùng mã cũng phải vào hàng kiểm tra: không biết booking còn hiệu lực hay đã hủy.
          for (const s of byRef.get(r.parsed.externalRef)!) {
            s.issues.push(issue("listed_in_cancel_sheet", `Mã cũng nằm ở sheet "${ws.name}" dòng ${sr.rowNumber} — cần xác nhận booking còn hiệu lực hay đã hủy.`, { sheet: ws.name, row: sr.rowNumber }));
          }
        }
        r.disposition = dispositionOf(r.issues);
        rows.push(r);
      }
      sheets.push({ name: ws.name, role, headerRow: header.row, dataRows: sheetRows.length });
      continue;
    }
    // Sheet nhà: chỉ đối chiếu, không cộng vào lô.
    const rec = { withRef: 0, noRef: 0, matched: 0, mismatched: 0, onlyInHouse: 0 };
    for (const sr of sheetRows) {
      const ref = text(sr.values.ref);
      if (!ref) {
        rec.noRef += 1;
        continue;
      }
      rec.withRef += 1;
      const inSource = byRef.get(ref);
      const ci = parseStayDate(sr.values.check_in).date;
      const co = parseStayDate(sr.values.check_out).date;
      if (inSource) {
        const same = inSource.some((s) => s.parsed.checkIn === ci && s.parsed.checkOut === co);
        if (same) rec.matched += 1;
        else {
          rec.mismatched += 1;
          for (const s of inSource) {
            s.issues.push(issue("house_sheet_mismatch", `Sheet "${ws.name}" dòng ${sr.rowNumber} ghi ngày ở khác.`, { sheet: ws.name, row: sr.rowNumber, checkIn: ci, checkOut: co }));
          }
        }
      } else {
        rec.onlyInHouse += 1;
        const r = interpretRow(ws.name, sr, opts.lookup);
        r.issues.unshift(issue("only_in_house_sheet", `Mã có ở sheet "${ws.name}" nhưng không có ở sheet ${sourceWs.name} — không nhập, chỉ báo để đối chiếu.`));
        r.disposition = dispositionOf(r.issues);
        rows.push(r);
      }
    }
    sheets.push({ name: ws.name, role, headerRow: header.row, dataRows: sheetRows.length, reconciliation: rec });
  }

  for (const r of sourceRows) r.disposition = dispositionOf(r.issues);
  return { sourceSheet: sourceWs.name, sheets, rows: [...sourceRows, ...rows] };
}

export class ParseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

export interface ImportStats {
  total: number;
  byDisposition: Record<string, number>;
  byIssue: Record<string, number>;
  bySheet: Record<string, number>;
}

export function summarizeRows(rows: Pick<ParsedImportRow, "disposition" | "issues" | "sheet">[]): ImportStats {
  const stats: ImportStats = { total: rows.length, byDisposition: {}, byIssue: {}, bySheet: {} };
  for (const r of rows) {
    stats.byDisposition[r.disposition] = (stats.byDisposition[r.disposition] ?? 0) + 1;
    stats.bySheet[r.sheet] = (stats.bySheet[r.sheet] ?? 0) + 1;
    for (const code of new Set(r.issues.map((i) => i.code))) stats.byIssue[code] = (stats.byIssue[code] ?? 0) + 1;
  }
  return stats;
}
