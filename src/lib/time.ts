/**
 * Thời gian vận hành. Quy tắc:
 *   - Lưu thời điểm dạng UTC (timestamptz).
 *   - Ngày ở / ngày vận hành là chuỗi YYYY-MM-DD theo múi giờ của nhà (Europe/Budapest).
 *   - Không cộng chênh lệch cố định: luôn hỏi Intl cho đúng thời điểm (đổi giờ mùa hè).
 */

export const OPS_TZ = "Europe/Budapest";

let clockOverride: (() => Date) | null = null;

/** Đồng hồ dùng chung — kiểm thử có thể cố định thời gian bằng setClock. */
export function now(): Date {
  return clockOverride ? clockOverride() : new Date();
}

export function setClock(fn: (() => Date) | null) {
  clockOverride = fn;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

function zonedParts(instant: Date, tz: string) {
  const parts = Object.fromEntries(partsFormatter(tz).formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Độ lệch (ms) của múi giờ so với UTC tại một thời điểm. */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Giờ địa phương (ngày + giờ:phút) → thời điểm UTC.
 * Giờ không tồn tại (khoảng nhảy mùa xuân) được đẩy về sau; giờ lặp (mùa thu) lấy lần đầu.
 */
export function localToUtc(date: string, time: string, tz = OPS_TZ): Date {
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm || !tm || !isValidDate(date)) throw new Error(`Ngày/giờ không hợp lệ: ${date} ${time}`);
  const wallUtc = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), Number(tm[3] ?? 0));
  // Lấy độ lệch trước và sau để xử lý cả hai phía của lần đổi giờ.
  const offsetBefore = tzOffsetMs(new Date(wallUtc - 36 * 3600_000), tz);
  const offsetAfter = tzOffsetMs(new Date(wallUtc + 36 * 3600_000), tz);
  const candidates = [wallUtc - offsetBefore, wallUtc - offsetAfter].sort((a, b) => a - b);
  for (const c of candidates) {
    const p = zonedParts(new Date(c), tz);
    if (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === wallUtc) return new Date(c);
  }
  // Giờ rơi vào khoảng nhảy: dùng độ lệch trước lần đổi → ra thời điểm ngay sau khoảng nhảy.
  return new Date(wallUtc - offsetBefore);
}

/** Ngày vận hành (YYYY-MM-DD) của một thời điểm theo múi giờ. */
export function localDateOf(instant: Date, tz = OPS_TZ): string {
  const p = zonedParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function localTimeOf(instant: Date, tz = OPS_TZ): string {
  const p = zonedParts(instant, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function todayOps(tz = OPS_TZ): string {
  return localDateOf(now(), tz);
}

export function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Ngày không hợp lệ: ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

export function diffDays(from: string, to: string): number {
  const a = DATE_RE.exec(from);
  const b = DATE_RE.exec(to);
  if (!a || !b) throw new Error(`Ngày không hợp lệ: ${from} / ${to}`);
  return Math.round(
    (Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) - Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]))) / 86400_000,
  );
}

/** Chuỗi time của Postgres ("15:00:00") → "15:00" */
export function hhmm(pgTime: string): string {
  return pgTime.slice(0, 5);
}

/** Tên múi giờ viết tắt tại thời điểm (CET/CEST) để hiện cạnh giờ trên lịch và báo cáo. */
export function tzAbbrev(instant: Date, tz = OPS_TZ): string {
  const offsetH = tzOffsetMs(instant, tz) / 3600_000;
  if (tz === "Europe/Budapest") return offsetH === 2 ? "CEST" : "CET";
  return `UTC${offsetH >= 0 ? "+" : ""}${offsetH}`;
}

export function formatDateVi(date: string | null | undefined): string {
  if (!date) return "—";
  const m = DATE_RE.exec(date);
  if (!m) return date;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

const WEEKDAYS_VI = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
export function weekdayVi(date: string): string {
  const m = DATE_RE.exec(date);
  if (!m) return "";
  return WEEKDAYS_VI[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
}

/** Hiển thị thời điểm theo giờ nhà kèm tên múi giờ: "16/09/2026 15:00 CEST" */
export function formatInstant(instant: Date | string | null | undefined, tz = OPS_TZ): string {
  if (!instant) return "—";
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return `${formatDateVi(localDateOf(d, tz))} ${localTimeOf(d, tz)} ${tzAbbrev(d, tz)}`;
}
