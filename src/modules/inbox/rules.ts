/**
 * Quy tắc thuần của hộp thư (không chạm DB): nhận diện yêu cầu nhạy cảm, bóc mã booking/ngày từ tin khách,
 * so tên, hạn nhận ticket. Tin khách là dữ liệu không tin cậy — chỉ dùng để phân loại, không bao giờ để đổi quyền.
 */

export type TicketCategory = "access" | "maintenance" | "cleaning" | "amenities" | "booking_change" | "payment_refund" | "complaint" | "question" | "other";
export type TicketPriority = "P0" | "P1" | "P2";

export const TICKET_CATEGORIES: TicketCategory[] = ["access", "maintenance", "cleaning", "amenities", "booking_change", "payment_refund", "complaint", "question", "other"];
export const TICKET_PRIORITIES: TicketPriority[] = ["P0", "P1", "P2"];

export interface SensitiveIntent {
  reason: "access_code" | "refund" | "incident" | "emergency" | "human_requested";
  category: TicketCategory;
  priority: TicketPriority;
}

/** Bỏ dấu + chữ thường để so khớp từ khoá và tên. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

const EMERGENCY = /\b(fire|smoke|gas leak|smell of gas|emergency|ambulance|police|chay nha|ro ri gas|cap cuu|tuz|mento|rendorseg|notfall|feuer)\b/;
const ACCESS = /(door ?code|access ?code|entry ?code|key ?code|lock ?code|pin ?code|\bpin\b|key ?box|lockbox|lock box|keypad|smart ?lock|can'?t get in|cannot get in|locked out|ma (mo )?cua|ma khoa|mat khau cua|khong vao duoc|turschloss|turcode|ajtokod|kulcs)/;
const REFUND = /(refund|money back|chargeback|reimburs|compensation|hoan tien|tra lai tien|boi thuong|erstattung|visszaterites)/;
const INCIDENT = /(broken|leak|flood|no hot water|no water|no electricity|power (is )?out|heating (is )?not|not working|doesn'?t work|does not work|bed ?bugs?|cockroach|mold|hong|ro nuoc|mat dien|mat nuoc|khong co nuoc nong|khong hoat dong|kaputt|defekt)/;
const HUMAN = /(speak|talk|chat) (to|with) (a |an )?(human|person|agent|someone|staff|manager)|real person|gap nguoi|noi chuyen voi nguoi|nhan vien that/;

/** Yêu cầu bot không được tự trả lời. Thứ tự ưu tiên: khẩn cấp → mã cửa → hoàn tiền → sự cố → xin gặp người. */
export function detectSensitiveIntent(text: string): SensitiveIntent | null {
  const t = fold(text);
  if (EMERGENCY.test(t)) return { reason: "emergency", category: "maintenance", priority: "P0" };
  if (ACCESS.test(t)) return { reason: "access_code", category: "access", priority: "P1" };
  if (REFUND.test(t)) return { reason: "refund", category: "payment_refund", priority: "P2" };
  if (INCIDENT.test(t)) return { reason: "incident", category: "maintenance", priority: "P1" };
  if (HUMAN.test(t)) return { reason: "human_requested", category: "question", priority: "P2" };
  return null;
}

/** Câu trả lời Q&A có dáng chứa mã truy cập — bot không đưa ra dù kho có duyệt nhầm. */
export function looksLikeAccessSecret(answer: string): boolean {
  const t = fold(answer);
  return /(code|pin|ma|password|mat khau|kod)\s*(is|la|:|=)?\s*[#*]?\d{3,}/.test(t) || (ACCESS.test(t) && /\d{4,}/.test(t));
}

export function acceptDueAt(priority: TicketPriority, from: Date): Date {
  const minutes = priority === "P2" ? 15 : 5;
  return new Date(from.getTime() + minutes * 60_000);
}

export function detectLanguage(text: string): "vi" | "en" {
  return /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text) ? "vi" : "en";
}

export interface BookingClaims {
  refs: string[];
  dates: string[];
}

function validYmd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Bóc ứng viên mã booking (chuỗi ≥5 ký tự chữ-số có ít nhất một chữ số) và ngày (YYYY-MM-DD, DD/MM/YYYY, DD.MM.YYYY).
 * Ngày dạng DD/MM theo quy ước châu Âu — không tự đảo sang MM/DD.
 */
export function extractBookingClaims(text: string): BookingClaims {
  const dates = new Set<string>();
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const v = validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (v) dates.add(v);
  }
  for (const m of text.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g)) {
    const v = validYmd(Number(m[3]), Number(m[2]), Number(m[1]));
    if (v) dates.add(v);
  }
  const stripped = text.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, " ");
  const refs = new Set<string>();
  for (const m of stripped.matchAll(/[A-Za-z0-9][A-Za-z0-9-]{4,39}/g)) {
    const token = m[0].replace(/-+$/, "");
    if (token.length >= 5 && /\d/.test(token)) refs.add(token.toUpperCase());
  }
  return { refs: [...refs].slice(0, 10), dates: [...dates].slice(0, 5) };
}

/** Tên người đặt khớp khi mọi từ (≥2 ký tự) của tên trong booking xuất hiện trong tin khách. */
export function nameMatches(guestFullName: string, text: string): boolean {
  const words = fold(guestFullName)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  if (words.length === 0) return false;
  const hay = new Set(fold(text).split(/[^a-z0-9]+/));
  return words.every((w) => hay.has(w));
}

/** Chuỗi số chuẩn để so số điện thoại (bỏ ký tự, bỏ tiền tố 00). */
export function phoneDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = value.replace(/@.*$/, "").replace(/\D/g, "").replace(/^00/, "");
  return d.length >= 8 ? d : null;
}
