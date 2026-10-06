/**
 * Bóc thư điện tử thô (RFC 822 / MIME) thành phần dùng được: người gửi, tiêu đề, ngày, và CHỮ.
 *
 * Tự viết thay vì thêm thư viện vì chỉ cần đúng mấy việc này, và thư viện bóc MIME đầy đủ kéo theo
 * nhiều phụ thuộc cho một kho mã công khai. Nếu sau này gặp thư quá lắt léo thì cân nhắc lại.
 *
 * Nguyên tắc: thư là dữ liệu KHÔNG tin cậy. Không bao giờ chạy gì trong thư, không theo đường dẫn
 * trong thư, không coi chữ trong thư là mệnh lệnh. Ở đây chỉ bóc ra chữ rồi cất.
 */

export interface ParsedEmail {
  messageId: string | null;
  from: string;
  to: string;
  subject: string;
  date: Date | null;
  text: string;
}

/** Gỡ gập dòng tiêu đề (dòng tiếp theo bắt đầu bằng khoảng trắng là phần nối của dòng trên). */
function unfold(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += " " + line.trim();
    else out.push(line);
  }
  return out;
}

function headerMap(headBlock: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of unfold(headBlock)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    // Tiêu đề lặp (Received…) chỉ giữ cái đầu; những cái mình cần đều chỉ có một.
    if (!m.has(key)) m.set(key, val);
  }
  return m;
}

/** =?utf-8?B?...?= và =?utf-8?Q?...?= — tiêu đề tiếng Việt gần như luôn mã hoá kiểu này. */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, kind: string, data: string) => {
    try {
      const buf =
        kind.toUpperCase() === "B"
          ? Buffer.from(data, "base64")
          : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(Number.parseInt(h, 16))), "latin1");
      return new TextDecoder(charset.toLowerCase().replace("windows-", "windows-")).decode(buf);
    } catch {
      return data;
    }
  });
}

function decodeBody(body: string, encoding: string, charset: string): string {
  const enc = encoding.toLowerCase();
  let buf: Buffer;
  if (enc === "base64") buf = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") {
    const joined = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] === "=" && /[0-9A-Fa-f]{2}/.test(joined.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(joined.charCodeAt(i) & 0xff);
    }
    buf = Buffer.from(bytes);
  } else buf = Buffer.from(body, "binary");
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

/** Bỏ thẻ HTML, giữ xuống dòng ở chỗ hợp lý để chữ còn đọc được. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const paramOf = (header: string, name: string): string => {
  const m = new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i").exec(header);
  return m ? m[1].trim() : "";
};

/**
 * Đi qua cây MIME, lấy phần chữ tốt nhất: ưu tiên text/plain, không có thì text/html bóc thẻ.
 * Đệ quy có giới hạn độ sâu để thư cố tình lồng nhiều lớp không làm treo.
 */
function extractText(headers: Map<string, string>, body: string, depth = 0): string {
  const ctype = headers.get("content-type") ?? "text/plain";
  const enc = headers.get("content-transfer-encoding") ?? "7bit";
  const charset = paramOf(ctype, "charset") || "utf-8";

  if (/^multipart\//i.test(ctype) && depth < 5) {
    const boundary = paramOf(ctype, "boundary");
    if (!boundary) return "";
    // Nhóm KHÔNG bắt: split có nhóm bắt sẽ chèn thêm phần đã bắt vào mảng kết quả.
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\r?\\n`));
    const texts: { plain: boolean; text: string }[] = [];
    for (const part of parts) {
      const sep = part.search(/\r?\n\r?\n/);
      if (sep < 0) continue;
      const h = headerMap(part.slice(0, sep));
      const b = part.slice(sep).replace(/^\r?\n\r?\n/, "");
      const t = extractText(h, b, depth + 1);
      if (t.trim()) texts.push({ plain: /text\/plain/i.test(h.get("content-type") ?? "text/plain"), text: t });
    }
    return (texts.find((t) => t.plain) ?? texts[0])?.text ?? "";
  }

  if (/text\/html/i.test(ctype)) return htmlToText(decodeBody(body, enc, charset));
  if (/^text\//i.test(ctype)) return decodeBody(body, enc, charset).trim();
  return ""; // tệp đính kèm: không bóc ở đây
}

const addrOf = (raw: string): string => {
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim().toLowerCase();
};

export function parseEmail(raw: string): ParsedEmail {
  const sep = raw.search(/\r?\n\r?\n/);
  const headBlock = sep < 0 ? raw : raw.slice(0, sep);
  const body = sep < 0 ? "" : raw.slice(sep).replace(/^\r?\n\r?\n/, "");
  const h = headerMap(headBlock);

  const dateRaw = h.get("date");
  const d = dateRaw ? new Date(dateRaw) : null;

  return {
    messageId: (h.get("message-id") ?? "").replace(/[<>]/g, "").trim() || null,
    from: addrOf(decodeWords(h.get("from") ?? "")),
    to: addrOf(decodeWords(h.get("to") ?? "")),
    subject: decodeWords(h.get("subject") ?? "").slice(0, 500),
    date: d && !Number.isNaN(d.getTime()) ? d : null,
    text: extractText(h, body).slice(0, 200_000),
  };
}
