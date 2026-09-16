import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, query, queryOne } from "@/lib/db";
import { createBooking, setStayStatus } from "@/modules/booking/service";
import { acceptTask, assignTask, inspectTask, startTask, toggleChecklistItem } from "@/modules/cleaning/service";
import { readDimensions, sniffImage } from "@/modules/photos/image";
import { evaluateRules, finishWithEvidence, reviewTask } from "@/modules/photos/qc";
import { getTaskEvidence } from "@/modules/photos/queries";
import { getPhotoFile, replacePhoto, uploadPhoto } from "@/modules/photos/service";
import { runVisionReview } from "@/modules/photos/vision";
import { bookingInput, expectCode, type Fixture, makeFixture, runWorker, tasksFor, uid } from "./helpers";

let uploadDir = "";
beforeAll(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-photos-"));
  process.env.UPLOAD_DIR = uploadDir;
});
afterAll(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

/** PNG tối thiểu đủ header IHDR để đọc kích thước; `salt` đổi sha256. */
function png(width: number, height: number, salt = uid()) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(salt)]);
}

function jpeg(width: number, height: number) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

async function version(bookingId: string) {
  return (await queryOne<{ version: number }>("SELECT version FROM bookings WHERE id = $1", [bookingId]))!.version;
}

/** Việc dọn R1 đang ở trạng thái đang dọn, giao cho cleaner đầu tiên. */
async function taskInProgress(f: Fixture) {
  const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
  await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_in", expectedVersion: await version(b.id) });
  await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_out", expectedVersion: await version(b.id) });
  await runWorker();
  const task = (await tasksFor(f.orgId))[0];
  const cleaner = f.cleaners[0];
  await assignTask(f.actors.bp_coordinator, task.id, { userId: cleaner.userId! });
  await acceptTask(cleaner, task.id);
  await startTask(cleaner, task.id);
  const items = await query<{ id: string; item_key: string; requires_photo: boolean }>("SELECT id, item_key, requires_photo FROM task_checklist_items WHERE task_id = $1 ORDER BY sort_order", [task.id]);
  return { task, cleaner, items, bath: items.find((i) => i.requires_photo)! };
}

const countFiles = (dir: string): number =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0) : 0;

describe("Ảnh bằng chứng — nhận dạng file", () => {
  it("đọc định dạng theo nội dung, không theo đuôi; đọc kích thước PNG/JPEG từ header", () => {
    expect(sniffImage(png(800, 600))).toBe("png");
    expect(readDimensions("png", png(800, 600))).toEqual({ width: 800, height: 600 });
    expect(sniffImage(jpeg(1024, 768))).toBe("jpeg");
    expect(readDimensions("jpeg", jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(sniffImage(Buffer.from("<html>giả làm ảnh.jpg</html>"))).toBeNull();
  });
});

describe("Ảnh bằng chứng — tải lên, quyền, kiểm theo luật", () => {
  it("gửi lặp cùng clientUploadId không nhân bản bản ghi hay file", async () => {
    const f = await makeFixture();
    const { task, cleaner, bath } = await taskInProgress(f);
    const clientUploadId = `c-${uid()}-${uid()}`;
    const data = png(1200, 900);
    const first = await uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId, data });
    const filesAfterFirst = countFiles(uploadDir);
    const second = await uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId, data });
    expect(first.alreadyStored).toBe(false);
    expect(second.alreadyStored).toBe(true);
    expect(second.photo.id).toBe(first.photo.id);
    expect(countFiles(uploadDir)).toBe(filesAfterFirst);
    const rows = await query("SELECT id FROM task_photos WHERE task_id = $1", [task.id]);
    expect(rows).toHaveLength(1);
    expect(first.photo.flags).toEqual([]);
    const audit = await query("SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'photos.uploaded'", [f.orgId]);
    expect(audit).toHaveLength(1);
    // Lưu ngoài public/, theo org/<orgId>/tasks/<taskId>/
    const key = (await queryOne<{ storage_key: string }>("SELECT storage_key FROM task_photos WHERE id = $1", [first.photo.id]))!.storage_key;
    expect(key.startsWith(`org/${f.orgId}/tasks/${task.id}/`)).toBe(true);
    expect(fs.existsSync(path.join(uploadDir, ...key.split("/")))).toBe(true);
  });

  it("cleaner khác nhận 404 (kể cả file hỏng); file giả đuôi bị từ chối 422", async () => {
    const f = await makeFixture();
    const { task, cleaner, bath } = await taskInProgress(f);
    const other = f.cleaners[1];
    await expectCode(uploadPhoto(other, { taskId: task.id, checklistItemId: bath.id, clientUploadId: `o-${uid()}-${uid()}`, data: Buffer.from("không phải ảnh") }), "not_found");
    const fake = await expectCode(
      uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId: `f-${uid()}-${uid()}`, data: Buffer.from("<?php echo 1; ?> anh.jpg") }),
      "unsupported_image",
    );
    expect((fake as unknown as { status: number }).status).toBe(422);
    expect(await query("SELECT id FROM task_photos WHERE task_id = $1", [task.id])).toHaveLength(0);
  });

  it("thiếu ảnh bắt buộc ⇒ luật báo không đủ bằng chứng và không cho hoàn thành; đủ ảnh thì hoàn thành, AI chưa kết nối không đổi trạng thái", async () => {
    const f = await makeFixture();
    const { task, cleaner, items, bath } = await taskInProgress(f);
    for (const item of items) await toggleChecklistItem(cleaner, task.id, item.id, { checked: true });

    const rules = await evaluateRules(pool(), f.orgId, task.id);
    expect(rules.complete).toBe(false);
    expect(rules.items.find((i) => i.itemId === bath.id)!.status).toBe("insufficient");
    const err = await expectCode(finishWithEvidence(cleaner, task.id), "photo_evidence_missing");
    expect((err.details as { missing: string[] }).missing).toEqual(["Nhà tắm"]);
    expect((await tasksFor(f.orgId))[0].status).toBe("in_progress");
    const recorded = await queryOne<{ status: string; items: { status: string }[] }>("SELECT status, items FROM qc_reviews WHERE task_id = $1 AND reviewer_type = 'rules'", [task.id]);
    expect(recorded!.items.some((i) => i.status === "insufficient")).toBe(true);

    // Ảnh không gắn mục checklist không tính là bằng chứng cho mục đó
    await uploadPhoto(cleaner, { taskId: task.id, category: "Chung", clientUploadId: `g-${uid()}-${uid()}`, data: png(1000, 800) });
    await expectCode(finishWithEvidence(cleaner, task.id), "photo_evidence_missing");

    await uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId: `b-${uid()}-${uid()}`, data: png(1000, 800) });
    const done = await finishWithEvidence(cleaner, task.id);
    expect(done.status).toBe("awaiting_inspection");
    const ai = await queryOne<{ status: string; summary: string }>("SELECT status, summary FROM qc_reviews WHERE task_id = $1 AND reviewer_type = 'ai'", [task.id]);
    expect(ai!.status).toBe("not_configured");
    expect(ai!.summary).toContain("AI chưa kết nối");

    const before = (await tasksFor(f.orgId))[0];
    const again = await reviewTask(f.actors.bp_staff, task.id);
    expect(again.ai.status).toBe("not_configured");
    const after = (await tasksFor(f.orgId))[0];
    expect(after.status).toBe("awaiting_inspection");
    expect(after.version).toBe(before.version);
    await expectCode(reviewTask(cleaner, task.id), "forbidden");
  });

  it("AI lỗi hoặc nói 'đạt' cho mục không nhìn được từ ảnh: ghi nhận, ép về không đủ bằng chứng, không bao giờ tự đạt", async () => {
    const f = await makeFixture();
    const { task, cleaner, bath } = await taskInProgress(f);
    const photo = await uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId: `a-${uid()}-${uid()}`, data: png(1000, 800) });
    await query("UPDATE task_checklist_items SET label = 'Nhà tắm không còn mùi' WHERE id = $1", [bath.id]);
    await query("INSERT INTO automation_switches (org_id, scope, scope_key, paused) VALUES ($1,'agent','cleaning',false)", [f.orgId]);
    const liar = { model: "fake", reviewPhotos: async () => [{ itemKey: "bath", status: "pass" as const, reason: "sạch, thơm", photoIds: [photo.photo.id] }] };
    const r = await runVisionReview(f.actors.bp_staff, { id: task.id, unit_id: f.units.r1 }, { reviewer: liar });
    expect(r.status).toBe("completed");
    const row = await queryOne<{ items: { status: string }[] }>("SELECT items FROM qc_reviews WHERE id = $1", [r.reviewId]);
    expect(row!.items[0].status).toBe("insufficient");
    const broken = { model: "fake", reviewPhotos: async () => Promise.reject(new Error("GPU mất kết nối")) };
    expect((await runVisionReview(f.actors.bp_staff, { id: task.id, unit_id: f.units.r1 }, { reviewer: broken })).status).toBe("failed");
    expect((await tasksFor(f.orgId))[0].status).toBe("in_progress");
  });

  it("khác tổ chức hoặc cleaner không được giao không đọc được ảnh; người xem toàn bộ trong tổ chức thì đọc được", async () => {
    const f = await makeFixture();
    const g = await makeFixture();
    const { task, cleaner, bath } = await taskInProgress(f);
    const data = png(700, 700);
    const { photo } = await uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId: `x-${uid()}-${uid()}`, data });
    expect((await getPhotoFile(cleaner, photo.id)).data.equals(data)).toBe(true);
    expect((await getPhotoFile(f.actors.bp_staff, photo.id)).mimeType).toBe("image/png");
    await expectCode(getPhotoFile(g.actors.admin, photo.id), "not_found");
    await expectCode(getPhotoFile(f.cleaners[1], photo.id), "not_found");
    await expectCode(getTaskEvidence(g.actors.admin, task.id), "not_found");
    await expectCode(getTaskEvidence(f.cleaners[1], task.id), "not_found");
    await expectCode(replacePhoto(g.actors.admin, photo.id), "not_found");
  });

  it("gắn cờ ảnh nhỏ và ảnh trùng với việc khác; thay ảnh không xoá file, việc đã đạt thì không thay được", async () => {
    const f = await makeFixture();
    const { task, cleaner, items, bath } = await taskInProgress(f);
    const small = await uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId: `s-${uid()}-${uid()}`, data: png(320, 480) });
    expect(small.photo.flags).toContain("low_resolution");
    // Cùng một ảnh đã dùng cho việc dọn phòng khác
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r2, "2026-10-01", "2026-10-03"));
    await runWorker();
    const otherTask = (await tasksFor(f.orgId)).find((t) => t.unit_id === f.units.r2)!;
    const reused = png(1600, 1200);
    await uploadPhoto(f.actors.bp_coordinator, { taskId: otherTask.id, clientUploadId: `r-${uid()}-${uid()}`, data: reused });
    const dup = await uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId: `d-${uid()}-${uid()}`, data: reused });
    expect(dup.photo.flags).toContain("duplicate_elsewhere");
    const evidence = await getTaskEvidence(cleaner, task.id);
    expect(evidence.rules.items.find((i) => i.itemId === bath.id)!.status).toBe("flagged");

    const key = (await queryOne<{ storage_key: string }>("SELECT storage_key FROM task_photos WHERE id = $1", [small.photo.id]))!.storage_key;
    await expectCode(replacePhoto(f.cleaners[1], small.photo.id), "not_found");
    await replacePhoto(cleaner, small.photo.id, "Ảnh mờ");
    expect((await queryOne<{ status: string }>("SELECT status FROM task_photos WHERE id = $1", [small.photo.id]))!.status).toBe("replaced");
    expect(fs.existsSync(path.join(uploadDir, ...key.split("/")))).toBe(true);
    await expectCode(replacePhoto(cleaner, small.photo.id), "photo_not_active");

    for (const item of items) await toggleChecklistItem(cleaner, task.id, item.id, { checked: true });
    await finishWithEvidence(cleaner, task.id);
    // Hết đang dọn: cleaner không thêm ảnh được nữa
    await expectCode(uploadPhoto(cleaner, { taskId: task.id, checklistItemId: bath.id, clientUploadId: `l-${uid()}-${uid()}`, data: png(900, 900) }), "invalid_transition");
    await inspectTask(f.actors.bp_staff, task.id, { result: "pass" });
    await expectCode(replacePhoto(f.actors.bp_coordinator, dup.photo.id), "task_closed");
  });
});
