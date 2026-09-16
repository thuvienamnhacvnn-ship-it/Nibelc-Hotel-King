"use client";

/**
 * Hàng đợi ảnh trên máy cleaner: ảnh chụp lúc mất mạng nằm ở IndexedDB tới khi MÁY CHỦ trả 200, rồi xoá ngay.
 * Không service worker, không cache phản hồi API. Trình duyệt chặn IndexedDB (chế độ riêng tư…) thì giữ trong bộ nhớ
 * — khi đó đóng trang là mất ảnh chưa gửi, giao diện phải nói rõ.
 */

export interface QueuedPhoto {
  clientUploadId: string;
  taskId: string;
  checklistItemId: string | null;
  category: string | null;
  blob: Blob;
  fileName: string;
  capturedAt: string;
  createdAt: number;
}

const DB_NAME = "vd-photo-queue";
const STORE = "photos";
const memory = new Map<string, QueuedPhoto>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === "undefined") return resolve(null);
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: "clientUploadId" });
          store.createIndex("taskId", "taskId");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** true nếu ảnh chờ gửi vẫn còn sau khi đóng trang. */
export async function queueIsPersistent(): Promise<boolean> {
  return (await openDb()) !== null;
}

export async function queueList(taskId: string): Promise<QueuedPhoto[]> {
  const db = await openDb();
  const inMemory = [...memory.values()].filter((p) => p.taskId === taskId);
  const stored = db ? await run(db, "readonly", (s) => s.index("taskId").getAll(taskId) as IDBRequest<QueuedPhoto[]>).catch(() => [] as QueuedPhoto[]) : [];
  const byId = new Map([...stored, ...inMemory].map((p) => [p.clientUploadId, p]));
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function queuePut(item: QueuedPhoto): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.set(item.clientUploadId, item);
    return;
  }
  try {
    await run(db, "readwrite", (s) => s.put(item));
  } catch {
    // Hết dung lượng / bị chặn giữa chừng: vẫn giữ trong bộ nhớ để gửi khi trang còn mở
    memory.set(item.clientUploadId, item);
  }
}

export async function queueDelete(clientUploadId: string): Promise<void> {
  memory.delete(clientUploadId);
  const db = await openDb();
  if (db) await run(db, "readwrite", (s) => s.delete(clientUploadId)).catch(() => undefined);
}

/** Mã tải lên sinh trên máy. crypto.randomUUID chỉ có trên HTTPS/localhost — điện thoại mở qua IP LAN thì dùng getRandomValues. */
export function newClientUploadId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `m-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
