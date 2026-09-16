/**
 * Chuẩn hoá chữ cho việc nhận diện — không dùng để hiển thị.
 * Tên phòng trong Excel viết rất nhiều kiểu ("Baby Room Jozsef krt50", "Baby Room J50", "Sweet Home Room Rak59",
 * "Sweet Home Rakoczi Ut.59"...). Hai tên cùng chỉ một sản phẩm phải ra cùng một khoá.
 */

/** Ký tự điều hướng chữ (LRE/PDF...) hay dính vào số điện thoại copy từ OTA. */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩﻿]/g;

export function stripBidi(text: string): string {
  return text.replace(BIDI_MARKS, "");
}

export function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

/** Tiêu đề cột → khoá so sánh: "GIỜ CHECK- IN" → "gio check in". */
export function normalizeHeader(text: string): string {
  return stripDiacritics(stripBidi(String(text)))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Chữ thường, bỏ dấu, gộp khoảng trắng — dùng để dò từ khoá trong ghi chú. */
export function looseText(text: string): string {
  return stripDiacritics(stripBidi(String(text))).toLowerCase().replace(/\s+/g, " ").trim();
}

const WORD_MAP: Record<string, string> = {
  flat: "apartment",
  apartment: "apartment",
  apartments: "apartment",
  apt: "apartment",
  baros: "baross",
  ference: "ferenc",
};
const DROP_WORDS = new Set(["room", "rooms", "at", "the", "entire"]);

/**
 * Khoá alias của tên căn/phòng.
 *   "Baby Room Jozsef krt50" / "Baby Room J50" / "baby room jozsef 50" → "baby j50"
 *   "Sweet Home Room Rak59" / "Sweet Home Rakoczi Ut.59"               → "home rak59 sweet"
 *   "Ulloi 0 Flat" / "Ulloi 0 Apartment"                                 → "apartment ulloi0"
 *   "Clever Pirates Jozsef 68" / "Clever pirate Jozsef 68"               → "clever j68 pirate"
 * Thứ tự từ không quan trọng ("J65 Studio" = "Studio Jozsef 65").
 */
export function normalizeUnitAlias(input: string): string {
  let s = stripDiacritics(stripBidi(String(input))).toLowerCase();
  s = s.replace(/^[\s']+/, "");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  s = s
    .replace(/\bjozsef\s*(?:krt|korut)?\s*(\d+)\b/g, "j$1")
    .replace(/\bj\s+(\d+)\b/g, "j$1")
    .replace(/\b(?:kerepesi|kere|ke)\s*(?:ut|utca)?\s*(\d+)\b/g, "ke$1")
    .replace(/\b(?:rakoczi|rak)\s*(?:ut|utca)?\s*(\d+)\b/g, "rak$1")
    .replace(/\bulloi\s*(?:ut|utca)?\s*(\d+)\b/g, "ulloi$1")
    .replace(/\bdob\s*(?:utca)?\s*(\d+)\b/g, "dob$1");
  const tokens = s
    .split(" ")
    .filter(Boolean)
    .map((t) => WORD_MAP[t] ?? t)
    .filter((t) => !DROP_WORDS.has(t))
    // Số nhiều cuối từ: "Pirates"/"Bigs"/"Angels" → "pirate"/"big"/"angel". Không đụng "princess", "baross".
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !/\d/.test(t) ? t.slice(0, -1) : t));
  return [...new Set(tokens)].sort().join(" ");
}
