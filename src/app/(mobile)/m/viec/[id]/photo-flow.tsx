"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, ErrorText, callApi } from "@/components/client";
import base from "../../../mobile.module.css";
import { useOnline } from "../../../mobile-client";
import styles from "./photos.module.css";
import { type QueuedPhoto, newClientUploadId, queueDelete, queueIsPersistent, queueList, queuePut } from "./photo-queue";

/**
 * Checklist + ảnh bằng chứng + nút Hoàn thành cho việc đang dọn.
 * Trạng thái ảnh chỉ ghi "đã lưu trên máy chủ" khi server trả 200 — ảnh chờ mạng không bao giờ được coi là đã gửi.
 */

export interface ServerPhoto {
  id: string;
  checklistItemId: string | null;
  clientUploadId: string;
  flags: string[];
  receivedAtLabel: string;
  mine: boolean;
}

export interface EvidenceItem {
  id: string;
  label: string;
  checked: boolean;
  requiresPhoto: boolean;
}

interface Props {
  taskId: string;
  version: number;
  canAct: boolean;
  canManage: boolean;
  checklist: { group: string; items: EvidenceItem[] }[];
  serverPhotos: ServerPhoto[];
  flagLabels: Record<string, string>;
}

type SendState = { state: "waiting" | "uploading" } | { state: "error"; message: string };

const MAX_BYTES = 15 * 1024 * 1024;

export function EvidenceChecklist(p: Props) {
  const router = useRouter();
  const online = useOnline();
  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  const [send, setSend] = useState<Record<string, SendState>>({});
  const [persistent, setPersistent] = useState(true);
  const [pendingItem, setPendingItem] = useState<string | null>(null);
  const [itemError, setItemError] = useState<ApiError | null>(null);
  const [finishBusy, setFinishBusy] = useState(false);
  const [finishError, setFinishError] = useState<ApiError | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const sending = useRef(false);
  // Lỗi mạng khi navigator vẫn báo online: đợi rồi mới thử lại, không gửi dồn liên tục
  const backoffUntil = useRef(0);
  const sendRef = useRef(send);
  sendRef.current = send;
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const serverClientIds = new Set(p.serverPhotos.map((s) => s.clientUploadId));

  // Nạp hàng đợi còn lại từ lần mở trước; ảnh máy chủ đã có thì bỏ khỏi máy.
  useEffect(() => {
    let alive = true;
    (async () => {
      setPersistent(await queueIsPersistent());
      const items = await queueList(p.taskId);
      for (const q of items.filter((i) => serverClientIds.has(i.clientUploadId))) await queueDelete(q.clientUploadId);
      if (alive) setQueue(items.filter((i) => !serverClientIds.has(i.clientUploadId)));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.taskId]);

  const pump = useCallback(async () => {
    if (sending.current || !navigator.onLine || Date.now() < backoffUntil.current) return;
    sending.current = true;
    let saved = false;
    try {
      const items = await queueList(p.taskId);
      for (const item of items) {
        if (sendRef.current[item.clientUploadId]?.state === "error") continue;
        setSend((s) => ({ ...s, [item.clientUploadId]: { state: "uploading" } }));
        const form = new FormData();
        form.set("file", item.blob, item.fileName);
        form.set("taskId", item.taskId);
        if (item.checklistItemId) form.set("checklistItemId", item.checklistItemId);
        if (item.category) form.set("category", item.category);
        form.set("clientUploadId", item.clientUploadId);
        form.set("clientCapturedAt", item.capturedAt);
        const r = await callApi(`/api/v1/photos`, { method: "POST", body: form });
        if (!r.error) {
          await queueDelete(item.clientUploadId);
          setQueue((q) => q.filter((x) => x.clientUploadId !== item.clientUploadId));
          setSend((s) => {
            const { [item.clientUploadId]: _, ...rest } = s;
            return rest;
          });
          saved = true;
        } else if (r.error.status === 0) {
          // Mất mạng giữa chừng: giữ nguyên, gửi lại khi có mạng
          backoffUntil.current = Date.now() + 15_000;
          setSend((s) => ({ ...s, [item.clientUploadId]: { state: "waiting" } }));
          break;
        } else {
          setSend((s) => ({ ...s, [item.clientUploadId]: { state: "error", message: r.error!.message } }));
        }
      }
    } finally {
      sending.current = false;
    }
    if (saved) router.refresh();
  }, [p.taskId, router]);

  useEffect(() => {
    if (online) backoffUntil.current = 0;
  }, [online]);

  useEffect(() => {
    if (online && queue.some((q) => (send[q.clientUploadId]?.state ?? "waiting") === "waiting")) void pump();
  }, [online, queue, send, pump]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (navigator.onLine) void pump();
    }, 20_000);
    return () => clearInterval(timer);
  }, [pump]);

  useEffect(() => {
    if (!queue.length || persistent) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue.length, persistent]);

  async function onCapture(item: EvidenceItem, file: File | undefined) {
    setCaptureError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setCaptureError("Ảnh lớn hơn 15 MB — chụp lại với chất lượng thấp hơn.");
      return;
    }
    const q: QueuedPhoto = {
      clientUploadId: newClientUploadId(),
      taskId: p.taskId,
      checklistItemId: item.id,
      category: null,
      blob: file,
      fileName: file.name || "anh.jpg",
      capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
      createdAt: Date.now(),
    };
    await queuePut(q);
    setQueue((cur) => [...cur, q]);
    setSend((s) => ({ ...s, [q.clientUploadId]: { state: "waiting" } }));
  }

  async function retry(id: string) {
    backoffUntil.current = 0;
    setSend((s) => ({ ...s, [id]: { state: "waiting" } }));
  }

  async function discard(id: string) {
    await queueDelete(id);
    setQueue((q) => q.filter((x) => x.clientUploadId !== id));
  }

  const missingRequired = p.checklist.flatMap((g) => g.items).filter((i) => i.requiresPhoto && !p.serverPhotos.some((s) => s.checklistItemId === i.id));
  const notOnServer = queue.length;
  const disabled = !online || pendingItem !== null || finishBusy;

  return (
    <>
      {!persistent ? (
        <div className="notice notice-warn strong">Trình duyệt không cho lưu ảnh chờ gửi trên máy — đừng đóng trang khi còn ảnh chưa lên máy chủ.</div>
      ) : null}
      {p.checklist.map((g) => (
        <div key={g.group} className={base.group}>
          <h2 className={base.sectionTitle}>{g.group}</h2>
          {g.items.map((i) => {
            const onServer = p.serverPhotos.filter((s) => s.checklistItemId === i.id);
            const local = queue.filter((q) => q.checklistItemId === i.id);
            return (
              <div key={i.id} className={styles.item}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={i.checked}
                  className={base.checkItem}
                  disabled={!p.canAct || disabled}
                  onClick={async () => {
                    setPendingItem(i.id);
                    setItemError(null);
                    const r = await callApi(`/api/v1/cleaning/tasks/${p.taskId}/checklist/${i.id}`, { method: "PATCH", body: { checked: !i.checked } });
                    setPendingItem(null);
                    if (r.error) setItemError(r.error);
                    else router.refresh();
                  }}
                >
                  <span className={base.box} aria-hidden>
                    {i.checked ? "✓" : ""}
                  </span>
                  <span style={{ flex: 1 }}>{i.label}</span>
                  {pendingItem === i.id ? <span className="small">Đang gửi…</span> : null}
                </button>

                {i.requiresPhoto || onServer.length || local.length ? (
                  <div className={styles.photos}>
                    <div className={styles.photoHead}>
                      <span className={onServer.length ? styles.ok : styles.need}>{onServer.length ? `Ảnh trên máy chủ: ${onServer.length}` : i.requiresPhoto ? "Cần ít nhất 1 ảnh" : "Ảnh"}</span>
                      {p.canAct ? (
                        <>
                          <input
                            ref={(el) => {
                              inputs.current[i.id] = el;
                            }}
                            type="file"
                            accept="image/*"
                            capture="environment"
                            className={styles.hiddenInput}
                            onChange={async (e) => {
                              await onCapture(i, e.target.files?.[0]);
                              e.target.value = "";
                            }}
                          />
                          <button type="button" className={`btn btn-primary ${styles.shoot}`} onClick={() => inputs.current[i.id]?.click()}>
                            Chụp ảnh
                          </button>
                        </>
                      ) : null}
                    </div>

                    {onServer.map((s) => (
                      <div key={s.id} className={styles.photoRow}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/v1/photos/${s.id}`} alt="" className={styles.thumb} loading="lazy" />
                        <div className={styles.photoMeta}>
                          <span className={styles.ok}>Đã lưu trên máy chủ</span>
                          <span className="small">{s.receivedAtLabel}</span>
                          {s.flags.map((f) => (
                            <span key={f} className={styles.flag}>
                              {p.flagLabels[f] ?? f}
                            </span>
                          ))}
                          {(s.mine || p.canManage) && p.canAct ? (
                            confirmRemove === s.id ? (
                              <span className={styles.actions}>
                                <button
                                  type="button"
                                  className="btn btn-danger"
                                  disabled={removeBusy || !online}
                                  onClick={async () => {
                                    setRemoveBusy(true);
                                    const r = await callApi(`/api/v1/photos/${s.id}?reason=${encodeURIComponent("Cleaner bỏ ảnh để chụp lại")}`, { method: "DELETE" });
                                    setRemoveBusy(false);
                                    setConfirmRemove(null);
                                    if (r.error) setItemError(r.error);
                                    else router.refresh();
                                  }}
                                >
                                  {removeBusy ? "Đang gửi…" : "Bỏ ảnh này"}
                                </button>
                                <button type="button" className="btn" onClick={() => setConfirmRemove(null)}>
                                  Giữ lại
                                </button>
                              </span>
                            ) : (
                              <button type="button" className={`btn ${styles.small}`} onClick={() => setConfirmRemove(s.id)}>
                                Bỏ ảnh / chụp lại
                              </button>
                            )
                          ) : null}
                        </div>
                      </div>
                    ))}

                    {local.map((q) => {
                      const st = send[q.clientUploadId] ?? { state: "waiting" as const };
                      return (
                        <div key={q.clientUploadId} className={styles.photoRow}>
                          <LocalThumb blob={q.blob} />
                          <div className={styles.photoMeta}>
                            {st.state === "uploading" ? <span className={styles.busy}>Đang tải lên…</span> : null}
                            {st.state === "waiting" ? <span className={styles.need}>{online ? "Chờ gửi" : "Đang chờ mạng"} — CHƯA lên máy chủ</span> : null}
                            {st.state === "error" ? (
                              <>
                                <span className={styles.need}>Lỗi — thử lại</span>
                                <span className="small">{st.message}</span>
                                <span className={styles.actions}>
                                  <button type="button" className="btn btn-primary" disabled={!online} onClick={() => retry(q.clientUploadId)}>
                                    Thử lại
                                  </button>
                                  <button type="button" className="btn" onClick={() => discard(q.clientUploadId)}>
                                    Bỏ ảnh
                                  </button>
                                </span>
                              </>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}

      {captureError ? <div className={base.offline}>{captureError}</div> : null}
      <ErrorText error={itemError} />

      {p.canAct ? (
        <>
          {notOnServer ? <div className="notice notice-warn strong">Còn {notOnServer} ảnh chưa lên máy chủ — chưa hoàn thành được.</div> : null}
          {missingRequired.length ? <div className="notice notice-warn strong">Thiếu ảnh bắt buộc: {missingRequired.map((i) => i.label).join(", ")}.</div> : null}
          <ErrorText error={finishError} />
          <button
            type="button"
            className={`btn btn-primary ${base.big}`}
            disabled={disabled || notOnServer > 0 || missingRequired.length > 0}
            onClick={async () => {
              setFinishBusy(true);
              setFinishError(null);
              const r = await callApi(`/api/v1/photos/tasks/${p.taskId}/finish`, { method: "POST", body: { expectedVersion: p.version } });
              setFinishBusy(false);
              if (r.error) setFinishError(r.error);
              else router.refresh();
            }}
          >
            {finishBusy ? "Đang gửi… (chưa hoàn thành)" : "Hoàn thành"}
          </button>
        </>
      ) : null}
    </>
  );
}

function LocalThumb({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (!url || broken) return <div className={styles.thumbEmpty}>Ảnh</div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className={styles.thumb} onError={() => setBroken(true)} />;
}
