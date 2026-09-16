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
 * Nội dung trông như mã cửa/mật khẩu — chặn RỘNG: báo nhầm thì người soạn sửa câu, lọt thì bot đọc mã cho khách.
 * Chuẩn hoá NFKC (số full-width) + bỏ dấu + chữ thường + gộp chữ tách rời ("c o d e", "p.i.n"), rồi tách token.
 * Bị chặn khi một từ khoá truy cập đứng cách (≤ 6 token) một trong các thứ:
 *   - dãy số ≥ 3 chữ số ("4711", "0815");
 *   - token chữ+số ≥ 6 ký tự trông như mật khẩu ("Sommer2024", "hanoi2024");
 *   - ≥ 3 số liền nhau viết bằng chữ hoặc chữ số lẻ ("four seven one one", "bốn bảy một một", "4 7 1 1").
 * Từ khoá Wi-Fi (wifi, wlan, ssid…) yếu hơn: chỉ chặn token giống mật khẩu hoặc dãy số ≥ 6 chữ số (tránh "Wi-Fi 500 Mbit").
 * Chấp nhận báo nhầm như "Zip code 1072".
 */
const ACCESS_SUBSTRINGS = ["code", "kod", "passw", "jelszo", "keybox", "lockbox", "keysafe", "schlussel", "tresor", "kulcs", "combination"];
const ACCESS_TOKENS = new Set(["pin", "pw", "pwd", "pass", "safe", "door", "gate", "kapu", "ajto", "combo", "ket"]);
const ACCESS_PHRASES = new Set(["ma cua", "ma khoa", "mat khau", "key box", "lock box", "ma cong", "ma ket", "ma pin", "ma so"]);
const WIFI_TOKENS = new Set(["wifi", "wlan", "ssid", "network", "netzwerk", "internet", "halozat"]);
const NUMBER_WORDS = new Set(
  (
    "zero one two three four five six seven eight nine " +
    "null eins zwei drei vier funf sechs sieben acht neun " +
    "nulla egy ketto ket harom negy ot hat het nyolc kilenc " +
    "khong mot hai ba bon tu nam sau bay tam chin linh"
  ).split(" "),
);
const NEAR = 6;
/** Chữ thường hay đứng sau "password:" mà không phải mã: "password: see card in room". */
const NOT_A_SECRET = new Set(["see", "xem", "posted", "provided", "available", "sent", "will", "check", "inside", "printed", "dan", "gui", "none", "khong", "in", "on", "the"]);

function normalizeForSecrets(input: string): string {
  return (
    input
      .normalize("NFKC")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      // "c o d e" / "p.i.n" → "code" / "pin"
      .replace(/(^|[^a-z0-9])((?:[a-z][ .]){2,}[a-z])(?![a-z0-9])/g, (_m, pre: string, run: string) => pre + run.replace(/[ .]/g, ""))
  );
}

export function looksLikeSecret(input: string | null | undefined): boolean {
  if (!input) return false;
  const text = normalizeForSecrets(input);
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);

  const strong: number[] = [];
  const weak: number[] = [];
  tokens.forEach((t, i) => {
    const isAccess = ACCESS_TOKENS.has(t) || ACCESS_SUBSTRINGS.some((k) => t.includes(k)) || (i > 0 && ACCESS_PHRASES.has(`${tokens[i - 1]} ${t}`));
    if (isAccess) {
      // Từ khoá dính liền số trong cùng token: "code4711", "pin0815"
      if ((t.match(/\d/g)?.length ?? 0) >= 3) return strong.push(-Infinity);
      strong.push(i);
    }
    if (WIFI_TOKENS.has(t) || (i > 0 && `${tokens[i - 1]} ${t}` === "wi fi")) weak.push(i);
  });
  if (strong.includes(-Infinity)) return true;
  if (!strong.length && !weak.length) return false;

  const near = (keys: number[], i: number) => keys.some((k) => Math.abs(k - i) <= NEAR);
  const passwordLike = (t: string) => t.length >= 6 && /[a-z]/.test(t) && /\d/.test(t);

  let numberRun = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const digitsOnly = /^\d+$/.test(t);
    if (digitsOnly && t.length >= 3 && near(strong, i)) return true;
    if (digitsOnly && t.length >= 6 && near(weak, i)) return true;
    if (passwordLike(t) && (near(strong, i) || near(weak, i))) return true;
    // Số viết bằng chữ hoặc từng chữ số rời: "four seven one one", "4 7 1 1"
    numberRun = NUMBER_WORDS.has(t) || (digitsOnly && t.length <= 2) ? numberRun + 1 : 0;
    if (numberRun >= 3 && near(strong, i)) return true;
  }

  // "password: sunflower" — mật khẩu chỉ có chữ, đứng ngay sau dấu ":"/"=" hoặc "is/là/ist"
  const m = /(?:passw\w*|jelszo\w*|mat khau(?: wifi)?|\bpwd?\b|passcode|kennwort)\s*(?:[:=]|\bis\b|\bla\b|\bist\b)\s*["'“]?([a-z]{4,})/.exec(text);
  return !!m && !NOT_A_SECRET.has(m[1]);
}

export const SECRET_REJECT_MESSAGE = "Không lưu mã cửa/mật khẩu trong Q&A — dùng công cụ truy cập có kiểm quyền.";
