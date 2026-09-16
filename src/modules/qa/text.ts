/**
 * Xử lý chữ cho Kho Q&A: chuẩn hoá để so khớp từ khoá (không dùng mô hình AI) và nhận diện nội dung giống bí mật.
 */

/** Bỏ dấu tiếng Việt/Hungary, chữ thường, chỉ giữ chữ-số và khoảng trắng. */
export function foldText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Cụm đồng nghĩa nhỏ vi/en → một từ chuẩn. Áp lên chuỗi đã foldText, cụm dài đặt trước.
 * Tránh cụm một chữ dễ nhầm sau khi bỏ dấu (ví dụ "muon" vừa là "muộn" vừa là "muốn").
 */
const SYNONYMS: [string, string][] = [
  ["tra phong muon", "late checkout"],
  ["tra muon", "late checkout"],
  ["nhan phong som", "early checkin"],
  ["nhan som", "early checkin"],
  ["mat khau wifi", "wifi password"],
  ["cho do xe", "parking"],
  ["bai do xe", "parking"],
  ["bai xe", "parking"],
  ["do xe", "parking"],
  ["gui xe", "parking"],
  ["car park", "parking"],
  ["garage", "parking"],
  ["park", "parking"],
  ["parken", "parking"],
  ["parkolo", "parking"],
  ["check out", "checkout"],
  ["check outs", "checkout"],
  ["tra phong", "checkout"],
  ["departure", "checkout"],
  ["check in", "checkin"],
  ["nhan phong", "checkin"],
  ["arrival", "checkin"],
  ["arrive", "checkin"],
  ["wi fi", "wifi"],
  ["wlan", "wifi"],
  ["internet", "wifi"],
  ["mat khau", "password"],
  ["ma cua", "doorcode"],
  ["door code", "doorcode"],
  ["access code", "doorcode"],
  ["key code", "doorcode"],
  ["key box", "keybox"],
  ["lockbox", "keybox"],
  ["lock box", "keybox"],
  ["chia khoa", "key"],
  ["keys", "key"],
  ["what time", "time"],
  ["may gio", "time"],
  ["luc nao", "time"],
  ["when", "time"],
  ["gio", "time"],
  ["hours", "time"],
  ["hour", "time"],
];

const SYNONYM_RULES = SYNONYMS.map(([from, to]) => ({ re: new RegExp(`(^| )${from}(?= |$)`, "g"), to }));

const STOPWORDS = new Set(
  (
    "a an the is are am was be been do does did can could would should will i we you he she they my our your me us to for of in on at by " +
    "and or but what where how which who there it its this that these those please hi hello hey thanks thank with have has had from any " +
    "get about as if so just also some tell know need want ok " +
    "toi minh ban em anh chi oi co khong la cua cho o the nao a nhe vay duoc xin chao va voi gi thi nay do ah da roi hay"
  ).split(" "),
);

function stem(token: string): string {
  // Số nhiều tiếng Anh đơn giản: towels → towel. Áp cả hai phía nên sai ngữ pháp cũng không sao.
  return token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

export function keywordTokens(input: string): Set<string> {
  let text = ` ${foldText(input)} `.trim();
  for (const rule of SYNONYM_RULES) text = text.replace(rule.re, `$1${rule.to}`);
  const tokens = new Set<string>();
  for (const raw of text.split(" ")) {
    if (!raw || STOPWORDS.has(raw)) continue;
    tokens.add(stem(raw));
  }
  return tokens;
}

/**
 * Nội dung trông như mã cửa/mật khẩu: từ khoá (code, pin, passcode, password, jelszó, kód, mã cửa, mật khẩu…)
 * theo sau là một chuỗi có chữ số, hoặc đứng ngay sau dấu ":"/"=".
 * Chấp nhận báo nhầm ít (ví dụ "zip code 1072") hơn là lọt mã thật vào Q&A mà bot có thể đọc ra.
 */
const SECRET_KEYWORD = "(?:passcode|password|passwort|pass|pwd|pin|code|kod|jelszo|ma cua|ma khoa|mat khau|doorcode|keycode)";
const SECRET_WITH_DIGIT = new RegExp(`(?:^|[^a-z])${SECRET_KEYWORD}(?:\\s*(?:is|la|lesz|ist|=|:|-|#)\\s*|\\s+)["'“]?([a-z0-9#*]*\\d[a-z0-9#*]*)`, "i");
const SECRET_AFTER_COLON = new RegExp(`(?:^|[^a-z])${SECRET_KEYWORD}\\s*[:=]\\s*["'“]?([^\\s"'”]{4,})`, "i");

/** Chữ thường hay đứng sau dấu ":" mà không phải mã: "password: see card in room". */
const NOT_A_SECRET = new Set(["see", "xem", "posted", "provided", "available", "sent", "will", "check", "inside", "printed", "dan", "gui", "none", "khong"]);

export function looksLikeSecret(input: string | null | undefined): boolean {
  if (!input) return false;
  // Giữ dấu ":" "=" "#" để phân biệt "code: 1234" với câu thường; chỉ bỏ dấu tiếng Việt/Hungary.
  const text = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
  if (SECRET_WITH_DIGIT.test(text)) return true;
  const m = SECRET_AFTER_COLON.exec(text);
  return !!m && !NOT_A_SECRET.has(m[1].replace(/[^a-z0-9]/g, ""));
}

export const SECRET_REJECT_MESSAGE = "Không lưu mã cửa/mật khẩu trong Q&A — dùng công cụ truy cập có kiểm quyền.";
