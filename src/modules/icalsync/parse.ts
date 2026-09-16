import { addDays, localDateOf } from "@/lib/time";

/**
 * Đọc iCal (RFC 5545) tối giản cho lịch bận/trống của Airbnb/Booking.com.
 * Chỉ lấy DTSTART/DTEND/UID của VEVENT. Kênh có thể ghi tên khách trong SUMMARY — KHÔNG giữ lại.
 */
export interface BusyRange {
  uid: string | null;
  start: string; // YYYY-MM-DD (đêm đầu)
  end: string; // YYYY-MM-DD (ngày trả, không tính đêm)
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseDateValue(raw: string, tz: string): string | null {
  const value = raw.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "Z" : ""}`;
    // Giờ không có Z được hiểu là giờ nhà (kênh xuất theo giờ địa phương)
    return m[7] ? localDateOf(new Date(iso), tz) : `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

export function parseIcal(text: string, tz = "Europe/Budapest"): { ranges: BusyRange[]; skipped: number } {
  const lines = unfold(text);
  const ranges: BusyRange[] = [];
  let skipped = 0;
  let inEvent = false;
  let cur: { uid: string | null; start: string | null; end: string | null } = { uid: null, start: null, end: null };
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      cur = { uid: null, start: null, end: null };
      continue;
    }
    if (line === "END:VEVENT") {
      inEvent = false;
      if (cur.start) {
        const end = cur.end ?? addDays(cur.start, 1);
        if (end > cur.start) ranges.push({ uid: cur.uid, start: cur.start, end });
        else skipped += 1;
      } else skipped += 1;
      continue;
    }
    if (!inEvent) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (name === "UID") cur.uid = value.trim().slice(0, 200);
    else if (name === "DTSTART") cur.start = parseDateValue(value, tz);
    else if (name === "DTEND") cur.end = parseDateValue(value, tz);
  }
  return { ranges, skipped };
}

/** Tập các đêm bận trong cửa sổ [from, to). */
export function nightsOf(ranges: { start: string; end: string }[], from: string, to: string): Set<string> {
  const out = new Set<string>();
  for (const r of ranges) {
    let d = r.start < from ? from : r.start;
    const stop = r.end > to ? to : r.end;
    while (d < stop) {
      out.add(d);
      d = addDays(d, 1);
    }
  }
  return out;
}

/** Gom các đêm liên tiếp thành khoảng [start, end). */
export function toRanges(nights: Iterable<string>): { start: string; end: string }[] {
  const sorted = [...nights].sort();
  const result: { start: string; end: string }[] = [];
  for (const n of sorted) {
    const last = result[result.length - 1];
    if (last && last.end === n) last.end = addDays(n, 1);
    else result.push({ start: n, end: addDays(n, 1) });
  }
  return result;
}

/** Hiện link dạng che: giữ tên miền và 4 ký tự cuối. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = url.slice(-4);
    return `${u.protocol}//${u.host}/…${tail}`;
  } catch {
    return "(link không hợp lệ)";
  }
}
