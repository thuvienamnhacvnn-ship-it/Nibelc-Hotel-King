import { type Queryable, query } from "@/lib/db";
import { newInboxStorageKey, removeOrphan, sha256, writeObject } from "@/modules/photos/storage";

/**
 * Ảnh / clip / tệp gửi vào hộp thư WhatsApp.
 *
 * Evolution chỉ kèm nội dung tệp vào webhook khi bật `webhookBase64`. KHÔNG tải lại sau bằng
 * `getBase64FromMediaMessage`: Evolution không giữ lịch sử, gọi muộn trả "Message not found"
 * (đã dính 19/09 với tệp Thảo gửi). Nhận được lúc nào thì phải ghi ra đĩa lúc đó.
 *
 * Nội dung nhị phân KHÔNG bao giờ nằm trong DB — chỉ lưu khoá tệp trong `messages.attachments`.
 * Tệp nằm ngoài `public/`, đọc qua đường có kiểm quyền như ảnh bằng chứng.
 *
 * Tệp người ngoài gửi là dữ liệu không tin cậy: không lấy tên file của họ làm tên lưu, không mở,
 * không chạy. Chữ trong ảnh cũng không phải chỉ dẫn cho hệ thống.
 */

/**
 * 16 MB — đúng mức WhatsApp cho gửi ảnh và clip. Lớn hơn thì base64 vượt `WEBHOOK_MAX_BYTES`
 * và webhook bị chặn từ vòng ngoài, nên có nhận cũng không tới nơi.
 */
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/csv": "csv",
};

/** Tệp đã ghi được, hoặc chỉ ghi nhận có tệp mà không lấy được nội dung. */
export interface StoredAttachment {
  kind: string;
  mimeType: string | null;
  /** Tên người gửi đặt — chỉ để hiển thị, không dùng làm đường dẫn. */
  fileName: string | null;
  bytes: number | null;
  storageKey?: string;
  sha256?: string;
  /** Vì sao không lấy được nội dung (quá lớn, kiểu lạ, webhook không kèm base64…). */
  error?: string;
  /**
   * Tệp y HỆT đã từng được gửi: ai gửi, lúc nào. Chỉ bắt được trò gửi lại đúng file cũ —
   * quay lại hoặc nén lại là mã băm đổi, chuyện đó thuộc lớp so vân tay hình ảnh.
   */
  duplicateOf?: { messageId: string; at: string; from: string | null };
}

export interface IncomingAttachment {
  kind: string;
  mimeType: string | null;
  fileName: string | null;
  base64: string | null;
  /** Vì sao hỏi kênh mà không lấy được nội dung — ghi lại để biết đường sửa. */
  fetchError?: string;
}

/** Phần mở rộng suy từ kiểu MIME; kiểu lạ thì không nhận (không đoán theo tên người gửi đặt). */
export function extensionForMime(mimeType: string | null): string | null {
  if (!mimeType) return null;
  return EXT_BY_MIME[mimeType.split(";")[0].trim().toLowerCase()] ?? null;
}

/** Ghi một tệp; hỏng thì trả về bản ghi có `error` chứ không ném — một tệp lỗi không được làm mất cả tin nhắn. */
export async function storeAttachment(orgId: string, conversationId: string, att: IncomingAttachment): Promise<StoredAttachment> {
  const base: StoredAttachment = { kind: att.kind, mimeType: att.mimeType, fileName: att.fileName?.slice(0, 200) ?? null, bytes: null };
  if (!att.base64) return { ...base, error: att.fetchError ? `khong_lay_duoc: ${att.fetchError}` : "khong_co_noi_dung" };

  const ext = extensionForMime(att.mimeType);
  if (!ext) return { ...base, error: "kieu_tep_khong_nhan" };

  let data: Buffer;
  try {
    data = Buffer.from(att.base64, "base64");
  } catch {
    return { ...base, error: "noi_dung_hong" };
  }
  if (data.length === 0) return { ...base, error: "tep_rong" };
  if (data.length > MAX_MEDIA_BYTES) return { ...base, bytes: data.length, error: "tep_qua_lon" };

  const storageKey = newInboxStorageKey(orgId, conversationId, ext);
  try {
    await writeObject(storageKey, data);
  } catch (error) {
    await removeOrphan(storageKey).catch(() => {});
    return { ...base, bytes: data.length, error: `khong_ghi_duoc: ${(error as Error).message}` };
  }
  return { ...base, bytes: data.length, storageKey, sha256: sha256(data) };
}

/** Tệp cùng nội dung đã nhận trước đó trong cùng tổ chức (tìm theo mã băm). */
export async function findPriorAttachment(orgId: string, hash: string, q?: Queryable) {
  const rows = await query<{ id: string; created_at: Date; contact_name: string | null }>(
    `SELECT m.id, m.created_at, c.contact_name
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.org_id = $1 AND m.attachments @> $2::jsonb
      ORDER BY m.created_at LIMIT 1`,
    [orgId, JSON.stringify([{ sha256: hash }])],
    q,
  );
  const r = rows[0];
  return r ? { messageId: r.id, at: new Date(r.created_at).toISOString(), from: r.contact_name } : null;
}

/**
 * Ghi cả loạt tệp của một tin, kèm soát trùng.
 * `q` phải là kết nối của giao dịch đang mở: lấy kết nối mới giữa giao dịch là tự kẹt.
 */
export async function storeAttachments(orgId: string, conversationId: string, atts: IncomingAttachment[], q?: Queryable): Promise<StoredAttachment[]> {
  const out: StoredAttachment[] = [];
  for (const a of atts) {
    const stored = await storeAttachment(orgId, conversationId, a);
    // Soát trùng TRƯỚC khi tin này được ghi, nên không bao giờ tự khớp với chính nó.
    if (stored.sha256) {
      const prior = await findPriorAttachment(orgId, stored.sha256, q);
      if (prior) stored.duplicateOf = prior;
    }
    out.push(stored);
  }
  return out;
}
