import { isValidDate } from "@/lib/time";
import { looseText } from "./normalize";

const pad = (n: number) => String(n).padStart(2, "0");

function ymd(year: number, month: number, day: number): string | null {
  const s = `${year}-${pad(month)}-${pad(day)}`;
  return isValidDate(s) ? s : null;
}

/** "29 tháng 9 2025" (kể cả xuống dòng/khoảng trắng thừa, "9 tháng 9, 2025") → "2025-09-29". Dạng này không mơ hồ. */
export function parseVietnameseDate(text: string): string | null {
  const s = looseText(text).replace(/[.,;]+$/, "");
  const m = /^(\d{1,2})\s*thang\s*(\d{1,2})\s*,?\s*(\d{4})$/.exec(s);
  if (!m) return null;
  return ymd(Number(m[3]), Number(m[2]), Number(m[1]));
}

export interface CellDate {
  date: string | null;
  /** text_vn: "29 tháng 9 2025"; text_dmy: dd/mm/yy(yy); date_cell: ô kiểu Date của Excel */
  source: "text_vn" | "text_dmy" | "date_cell" | "empty" | "unparsed";
  /** Ô Date có ngày ≤ 12: Excel có thể đã đảo ngày/tháng khi người nhập gõ dd/mm — không tự sửa, chỉ gắn cờ. */
  ambiguous: boolean;
}

/** Ô Date của exceljs là thời điểm UTC nửa đêm — đọc theo UTC để không lệch múi giờ máy. */
function fromDateCell(d: Date): CellDate {
  const day = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  return { date: ymd(d.getUTCFullYear(), month, day), source: "date_cell", ambiguous: day <= 12 && day !== month };
}

/**
 * Ngày nhận booking: chuỗi dd/mm/yy, dd/mm/yyyy, dd.mm.yyyy (quy ước sheet là ngày trước tháng) hoặc ô Date.
 * Năm 2 chữ số hiểu là 20yy — đó là cách đọc quy ước, không phải sửa năm.
 */
export function parseDmyOrCell(value: unknown): CellDate {
  if (value == null || value === "") return { date: null, source: "empty", ambiguous: false };
  if (value instanceof Date) return fromDateCell(value);
  const s = String(value).trim().replace(/^'+/, "");
  if (!s) return { date: null, source: "empty", ambiguous: false };
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const date = ymd(year, Number(m[2]), Number(m[1]));
    return { date, source: date ? "text_dmy" : "unparsed", ambiguous: false };
  }
  const vn = parseVietnameseDate(s);
  if (vn) return { date: vn, source: "text_vn", ambiguous: false };
  return { date: null, source: "unparsed", ambiguous: false };
}

/** Ngày nhận/trả phòng: chuẩn là chuỗi tiếng Việt; ô Date vẫn nhận nhưng gắn cờ nếu mơ hồ. */
export function parseStayDate(value: unknown): CellDate {
  if (value == null || value === "") return { date: null, source: "empty", ambiguous: false };
  if (value instanceof Date) return fromDateCell(value);
  const vn = parseVietnameseDate(String(value));
  if (vn) return { date: vn, source: "text_vn", ambiguous: false };
  return { date: null, source: "unparsed", ambiguous: false };
}
