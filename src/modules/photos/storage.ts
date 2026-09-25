import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Ảnh bằng chứng nằm NGOÀI `public/` — chỉ đọc được qua GET /api/v1/photos/[id] (kiểm quyền + tổ chức).
 * Khoá lưu: org/<orgId>/tasks/<taskId>/<uuid>.<ext>, do server sinh; không bao giờ lấy tên file từ máy khách.
 */
export function uploadRoot(): string {
  return path.resolve(process.env.UPLOAD_DIR || "./uploads");
}

export function newStorageKey(orgId: string, taskId: string, ext: string): string {
  return ["org", orgId, "tasks", taskId, `${crypto.randomUUID()}.${ext}`].join("/");
}

/** Tệp khách/đội gửi vào hộp thư. Cùng gốc lưu với ảnh bằng chứng nên cùng một luật đọc có kiểm quyền. */
export function newInboxStorageKey(orgId: string, conversationId: string, ext: string): string {
  return ["org", orgId, "inbox", conversationId, `${crypto.randomUUID()}.${ext}`].join("/");
}

function resolveKey(key: string): string {
  const root = uploadRoot();
  const full = path.resolve(root, ...key.split("/"));
  if (!full.startsWith(root + path.sep)) throw new Error("Khoá lưu ảnh nằm ngoài thư mục tải lên");
  return full;
}

export async function writeObject(key: string, data: Buffer) {
  const full = resolveKey(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  // wx: không bao giờ ghi đè file đã có
  await fs.writeFile(full, data, { flag: "wx" });
}

export async function readObject(key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(resolveKey(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Chỉ dùng để dọn file khi giao dịch ghi bản ghi thất bại — ảnh đã có bản ghi thì không xoá file. */
export async function removeOrphan(key: string) {
  await fs.rm(resolveKey(key), { force: true });
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
