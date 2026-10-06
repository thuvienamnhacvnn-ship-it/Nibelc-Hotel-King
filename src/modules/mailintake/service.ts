import fs from "node:fs/promises";
import path from "node:path";
import { query, queryOne } from "@/lib/db";
import { parseEmail } from "./parse";

/**
 * Đọc hộp thư của hệ thống và cất từng thư vào bảng `inbound_emails`.
 *
 * Hộp thư ở dạng Maildir do Postfix ghi: thư mới nằm trong `new/`, đọc xong chuyển sang `cur/`.
 * Chuyển tệp là bước CUỐI, sau khi đã ghi DB xong — chết giữa chừng thì lần sau đọc lại, và
 * `message_id` duy nhất theo tổ chức nên không sinh bản ghi thứ hai.
 *
 * Ở bước này CHỈ nhận và cất, chưa bóc thành đơn đặt phòng: chưa có mẫu thư thật của kênh nên
 * viết bộ bóc bây giờ là đoán mò. Thư nằm ở trạng thái 'pending' cho tới khi có bộ bóc.
 */

/**
 * Đọc biến môi trường LÚC CHẠY, không phải lúc nạp mô-đun: đọc lúc nạp thì ai đặt biến sau đó
 * (kiểm thử, hoặc worker nạp .env muộn) đều không có tác dụng.
 */
export function mailDir(): string {
  return process.env.MAIL_INTAKE_DIR || "/opt/vd-hotel/mail/vietduc-hub.com/datphong";
}
/** Thư lớn hơn mức này là bất thường với thư báo đặt phòng — bỏ qua, không đọc vào bộ nhớ. */
const MAX_MAIL_BYTES = 10 * 1024 * 1024;

export interface IntakeResult extends Record<string, number> {
  seen: number;
  stored: number;
  duplicate: number;
  skipped: number;
  failed: number;
}

/** Người gửi mình thật sự quan tâm. Thư khác vẫn cất nhưng đánh dấu 'ignored' để khỏi lẫn. */
function kindOfSender(from: string): string | null {
  if (/@([a-z0-9-]+\.)*booking\.com$/i.test(from)) return "booking_com";
  if (/@([a-z0-9-]+\.)*airbnb\.(com|[a-z.]+)$/i.test(from)) return "airbnb";
  return null;
}

async function ensureDirs() {
  for (const d of ["new", "cur"]) await fs.mkdir(path.join(mailDir(), d), { recursive: true });
}

export async function runMailIntake(orgSlug = "nibelc"): Promise<IntakeResult> {
  const out: IntakeResult = { seen: 0, stored: 0, duplicate: 0, skipped: 0, failed: 0 };
  const org = await queryOne<{ id: string }>("SELECT id FROM organizations WHERE slug = $1", [orgSlug]);
  if (!org) return out;

  try {
    await ensureDirs();
  } catch {
    return out; // chưa dựng hộp thư trên máy này (ví dụ máy dev) — không coi là lỗi
  }

  const newDir = path.join(mailDir(), "new");
  let files: string[];
  try {
    files = (await fs.readdir(newDir)).sort();
  } catch {
    return out;
  }

  for (const name of files.slice(0, 200)) {
    const full = path.join(newDir, name);
    out.seen += 1;
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_MAIL_BYTES) {
        await fs.rename(full, path.join(mailDir(), "cur", name));
        out.skipped += 1;
        continue;
      }

      const mail = parseEmail(await fs.readFile(full, "utf8"));
      // Thư không có Message-Id thì tự đặt theo tên tệp Maildir (tên này vốn đã duy nhất).
      const messageId = mail.messageId ?? `maildir:${name}`;
      const kind = kindOfSender(mail.from);

      const ins = await query<{ id: string }>(
        `INSERT INTO inbound_emails (org_id, message_id, from_addr, to_addr, subject, sent_at, body_text, status, detected_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (org_id, message_id) DO NOTHING RETURNING id`,
        [org.id, messageId, mail.from, mail.to, mail.subject, mail.date, mail.text, kind ? "pending" : "ignored", kind],
      );
      if (ins.length) out.stored += 1;
      else out.duplicate += 1;

      await fs.rename(full, path.join(mailDir(), "cur", name));
    } catch (error) {
      out.failed += 1;
      console.error("[mail-intake] lỗi đọc thư", name, (error as Error).message);
    }
  }
  return out;
}

/** Thư đã nhận nhưng chưa bóc được thành đơn — chỗ để viết bộ bóc dựa trên mẫu thật. */
export async function pendingEmails(orgId: string, limit = 20) {
  return query<{ id: string; from_addr: string; subject: string; received_at: Date; detected_kind: string | null; body_text: string }>(
    `SELECT id, from_addr, subject, received_at, detected_kind, body_text
       FROM inbound_emails WHERE org_id = $1 AND status = 'pending'
      ORDER BY received_at DESC LIMIT $2`,
    [orgId, limit],
  );
}
