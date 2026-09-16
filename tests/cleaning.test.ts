import { describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { createBooking, requestChange, setStayStatus } from "@/modules/booking/service";
import {
  acceptTask,
  acknowledgeChange,
  assignTask,
  declineTask,
  finishTask,
  inspectTask,
  reportIncident,
  resolveIncident,
  startTask,
  toggleChecklistItem,
} from "@/modules/cleaning/service";
import { readinessForUnits } from "@/modules/cleaning/readiness";
import { attachRequiredPhotos, bookingInput, expectCode, makeFixture, runWorker, tasksFor } from "./helpers";

async function version(bookingId: string) {
  return (await queryOne<{ version: number }>("SELECT version FROM bookings WHERE id = $1", [bookingId]))!.version;
}

describe("Trợ lý 2 — lập và điều chỉnh việc dọn", () => {
  it("khách đến cùng ngày ⇒ việc quay vòng có hạn trước giờ nhận phòng; chạy worker lặp không nhân bản việc", async () => {
    const f = await makeFixture();
    const a = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.whole, "2026-10-03", "2026-10-05"));
    await runWorker();
    await runWorker();
    const tasks = await tasksFor(f.orgId);
    const turnover = tasks.find((t) => t.departing_booking_id === a.id)!;
    expect(turnover.kind).toBe("turnover");
    expect(new Date(turnover.due_at).toISOString()).toBe("2026-10-03T13:00:00.000Z"); // 15:00 CEST
    expect(tasks.filter((t) => t.departing_booking_id === a.id)).toHaveLength(1);
    expect(tasks.filter((t) => t.departing_booking_id === b.id)).toHaveLength(1);
  });

  it("gia hạn khi cleaner đã nhận việc: không tự đổi, yêu cầu xác nhận; việc chưa nhận thì xếp lại luôn", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    const other = await createBooking(f.actors.vn_staff, bookingInput(f.units.r2, "2026-10-01", "2026-10-03"));
    await runWorker();
    const [t1, t2] = [(await tasksFor(f.orgId)).find((t) => t.departing_booking_id === b.id)!, (await tasksFor(f.orgId)).find((t) => t.departing_booking_id === other.id)!];
    const cleaner = f.cleaners[0];
    await assignTask(f.actors.bp_coordinator, t1.id, { userId: cleaner.userId! });
    await acceptTask(cleaner, t1.id);

    await requestChange(f.actors.vn_manager, b.id, { kind: "dates", checkInDate: "2026-10-01", checkOutDate: "2026-10-04" }, { applyNow: true });
    await requestChange(f.actors.vn_manager, other.id, { kind: "dates", checkInDate: "2026-10-01", checkOutDate: "2026-10-04" }, { applyNow: true });
    await runWorker();

    const tasks = await tasksFor(f.orgId);
    const accepted = tasks.find((t) => t.id === t1.id)!;
    expect(accepted.service_date).toBe("2026-10-03");
    expect(accepted.change_ack_required).toBe(true);
    // Việc mới cho đoạn phân bổ mới được tạo; việc cũ đã nhận chờ xác nhận hủy.
    expect((accepted.pending_change as { cancel?: boolean }).cancel).toBe(true);
    const unaccepted = tasks.find((t) => t.id === t2.id)!;
    expect(unaccepted.status).toBe("cancelled");
    const replacements = tasks.filter((t) => t.status === "pending_assignment" && t.service_date === "2026-10-04");
    expect(replacements).toHaveLength(2);

    await expectCode(startTask(cleaner, t1.id), "change_ack_required");
    await acknowledgeChange(cleaner, t1.id);
    expect((await tasksFor(f.orgId)).find((t) => t.id === t1.id)!.status).toBe("cancelled");
  });

  it("không cho vào phòng chỉ dựa vào giờ trả phòng dự kiến", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    await runWorker();
    const task = (await tasksFor(f.orgId))[0];
    const cleaner = f.cleaners[0];
    await assignTask(f.actors.bp_coordinator, task.id, { userId: cleaner.userId! });
    await acceptTask(cleaner, task.id);
    await expectCode(startTask(cleaner, task.id), "guest_not_confirmed_out");
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_in", expectedVersion: await version(b.id) });
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_out", expectedVersion: await version(b.id) });
    await runWorker();
    await startTask(cleaner, task.id);
  });

  it("thiếu checklist không hoàn thành được; sự cố chặn thì không duyệt sẵn sàng; chỉ Budapest Team duyệt", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_in", expectedVersion: await version(b.id) });
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_out", expectedVersion: await version(b.id) });
    await runWorker();
    const task = (await tasksFor(f.orgId))[0];
    const cleaner = f.cleaners[0];
    await assignTask(f.actors.bp_coordinator, task.id, { userId: cleaner.userId! });
    await acceptTask(cleaner, task.id);
    await startTask(cleaner, task.id);
    await expectCode(finishTask(cleaner, task.id), "checklist_incomplete");
    const items = await query<{ id: string }>("SELECT id FROM task_checklist_items WHERE task_id = $1", [task.id]);
    for (const item of items) await toggleChecklistItem(cleaner, task.id, item.id, { checked: true });
    const incident = await reportIncident(cleaner, task.id, { kind: "maintenance", severity: "blocking", description: "Vòi nước rò" });
    await attachRequiredPhotos(task.id, cleaner.userId!);
    await finishTask(cleaner, task.id);
    await expectCode(inspectTask(f.actors.vn_manager, task.id, { result: "pass" }), "forbidden");
    await expectCode(inspectTask(f.actors.bp_staff, task.id, { result: "pass" }), "blocking_incident");
    await resolveIncident(f.actors.bp_coordinator, incident.id, "Đã thay gioăng");
    await inspectTask(f.actors.bp_staff, task.id, { result: "pass" });
    const readiness = await readinessForUnits({ query: (s: string, p: unknown[]) => import("@/lib/db").then((m) => m.pool().query(s, p)) } as never, f.orgId, [f.units.r1, f.units.whole]);
    expect(readiness.get(f.units.r1)).toBe("ready");
    // Nguyên căn chưa sẵn sàng vì R2/R3 chưa được kiểm.
    expect(readiness.get(f.units.whole)).toBe("unknown");
  });

  it("QA C1/N2/N4: thay đổi chờ xác nhận chặn mọi bước; dọn lại xoá checklist; hủy việc đang dọn trả phòng về chưa dọn", async () => {
    const { addDays, todayOps } = await import("@/lib/time");
    const { pool } = await import("@/lib/db");
    const { cancelTask } = await import("@/modules/cleaning/service");
    const f = await makeFixture();
    const today = todayOps();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, addDays(today, -2), today));
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_in", expectedVersion: await version(b.id) });
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_out", expectedVersion: await version(b.id) });
    await runWorker();
    const task = (await tasksFor(f.orgId))[0];
    const cleaner = f.cleaners[0];
    await assignTask(f.actors.bp_coordinator, task.id, { userId: cleaner.userId! });
    await acceptTask(cleaner, task.id);
    await startTask(cleaner, task.id);
    const items = await query<{ id: string }>("SELECT id FROM task_checklist_items WHERE task_id = $1", [task.id]);
    for (const item of items) await toggleChecklistItem(cleaner, task.id, item.id, { checked: true });
    await attachRequiredPhotos(task.id, cleaner.userId!);
    await finishTask(cleaner, task.id);
    // N2: kiểm không đạt → checklist phải tích lại
    await inspectTask(f.actors.bp_staff, task.id, { result: "fail", note: "Nhà tắm còn bẩn" });
    const rechecked = await query<{ checked: boolean }>("SELECT checked FROM task_checklist_items WHERE task_id = $1", [task.id]);
    expect(rechecked.every((r) => !r.checked)).toBe(true);
    await acceptTask(cleaner, task.id);
    await startTask(cleaner, task.id);
    // C1: gắn cờ thay đổi chờ xác nhận thì tích checklist / hoàn thành bị chặn
    await query("UPDATE cleaning_tasks SET change_ack_required = true, pending_change = '{\"cancel\":true}' WHERE id = $1", [task.id]);
    await expectCode(toggleChecklistItem(cleaner, task.id, items[0].id, { checked: true }), "change_ack_required");
    await expectCode(finishTask(cleaner, task.id), "change_ack_required");
    await query("UPDATE cleaning_tasks SET change_ack_required = false, pending_change = NULL WHERE id = $1", [task.id]);
    // N4: hủy khi đang dọn → phòng về "chưa dọn", không kẹt ở "đang dọn"
    await cancelTask(f.actors.bp_coordinator, task.id, "Đổi người dọn");
    expect((await readinessForUnits(pool(), f.orgId, [f.units.r1])).get(f.units.r1)).toBe("vacated_dirty");
  });

  it("QA C2: chỉ điều phối xác nhận khách rời, không cho việc tương lai", async () => {
    const { addDays, todayOps } = await import("@/lib/time");
    const { confirmVacated } = await import("@/modules/cleaning/service");
    const f = await makeFixture();
    const today = todayOps();
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, addDays(today, -1), today));
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r2, today, addDays(today, 3)));
    await runWorker();
    const tasks = await tasksFor(f.orgId);
    const todayTask = tasks.find((t) => t.service_date === today)!;
    const futureTask = tasks.find((t) => t.service_date > today)!;
    await expectCode(confirmVacated(f.actors.vn_staff, todayTask.id, "khách nhắn"), "forbidden");
    await expectCode(confirmVacated(f.actors.bp_staff, todayTask.id, "khách nhắn"), "forbidden");
    await expectCode(confirmVacated(f.actors.bp_coordinator, futureTask.id, "khách nhắn"), "service_date_in_future");
    await confirmVacated(f.actors.bp_coordinator, todayTask.id, "Khách nhắn đã trả chìa");
  });

  it("booking đã trả phòng trong quá khứ (nhập lịch sử) không sinh việc dọn quá hạn", async () => {
    const f = await makeFixture();
    const { addDays, todayOps } = await import("@/lib/time");
    const today = todayOps();
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, addDays(today, -10), addDays(today, -7)));
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r2, addDays(today, -2), today));
    await runWorker();
    const tasks = await tasksFor(f.orgId);
    expect(tasks.map((t) => t.service_date)).toEqual([today]);
  });

  it("đóng sự cố không chặn không làm phòng mất trạng thái sẵn sàng", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_in", expectedVersion: await version(b.id) });
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_out", expectedVersion: await version(b.id) });
    await runWorker();
    const task = (await tasksFor(f.orgId))[0];
    const cleaner = f.cleaners[0];
    await assignTask(f.actors.bp_coordinator, task.id, { userId: cleaner.userId! });
    await acceptTask(cleaner, task.id);
    await startTask(cleaner, task.id);
    for (const item of await query<{ id: string }>("SELECT id FROM task_checklist_items WHERE task_id = $1", [task.id])) {
      await toggleChecklistItem(cleaner, task.id, item.id, { checked: true });
    }
    const minor = await reportIncident(cleaner, task.id, { kind: "missing_supplies", severity: "low", description: "Thiếu giấy vệ sinh" });
    await attachRequiredPhotos(task.id, cleaner.userId!);
    await finishTask(cleaner, task.id);
    await inspectTask(f.actors.bp_staff, task.id, { result: "pass" });
    await resolveIncident(f.actors.bp_coordinator, minor.id, "Đã bổ sung");
    const { pool } = await import("@/lib/db");
    expect((await readinessForUnits(pool(), f.orgId, [f.units.r1])).get(f.units.r1)).toBe("ready");
  });

  it("hủy trước khi khách đến thì hủy việc chưa nhận; hủy sau khi khách đã ở thì vẫn giữ việc dọn", async () => {
    const f = await makeFixture();
    const before = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    const after = await createBooking(f.actors.vn_staff, bookingInput(f.units.r2, "2026-10-01", "2026-10-03"));
    await runWorker();
    await setStayStatus(f.actors.bp_staff, after.id, { status: "checked_in", expectedVersion: await version(after.id) });
    await requestChange(f.actors.vn_manager, before.id, { kind: "cancel", reason: "Khách hủy" }, { applyNow: true });
    // Khách đang ở thì không hủy được — phải đổi ngày trả.
    const cr = await requestChange(f.actors.vn_manager, after.id, { kind: "cancel", reason: "thử" });
    expect(cr.check.issues.map((i) => i.code)).toContain("already_checked_in");
    await runWorker();
    const tasks = await tasksFor(f.orgId);
    expect(tasks.find((t) => t.departing_booking_id === before.id)!.status).toBe("cancelled");
    expect(tasks.find((t) => t.departing_booking_id === after.id)!.status).toBe("pending_assignment");
  });

  it("cleaner chỉ thấy việc của mình; từ chối việc phải có lý do và trả về hàng chờ phân công", async () => {
    const f = await makeFixture();
    await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    await runWorker();
    const task = (await tasksFor(f.orgId))[0];
    const [mine, other] = f.cleaners;
    await assignTask(f.actors.bp_coordinator, task.id, { userId: mine.userId! });
    await expectCode(acceptTask(other, task.id), "not_found");
    await expectCode(declineTask(mine, task.id, " "), "invalid_input");
    await declineTask(mine, task.id, "Trùng ca khác");
    expect((await tasksFor(f.orgId))[0].status).toBe("pending_assignment");
  });
});

describe("Ảnh bằng chứng bắt buộc", () => {
  it("thiếu ảnh ở mục cần ảnh thì không hoàn thành được, dù gọi thẳng service", async () => {
    const f = await makeFixture();
    const b = await createBooking(f.actors.vn_staff, bookingInput(f.units.r1, "2026-10-01", "2026-10-03"));
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_in", expectedVersion: await version(b.id) });
    await setStayStatus(f.actors.bp_staff, b.id, { status: "checked_out", expectedVersion: await version(b.id) });
    await runWorker();
    const task = (await tasksFor(f.orgId))[0];
    const cleaner = f.cleaners[0];
    await assignTask(f.actors.bp_coordinator, task.id, { userId: cleaner.userId! });
    await acceptTask(cleaner, task.id);
    await startTask(cleaner, task.id);
    for (const item of await query<{ id: string }>("SELECT id FROM task_checklist_items WHERE task_id = $1", [task.id])) {
      await toggleChecklistItem(cleaner, task.id, item.id, { checked: true });
    }
    const err = await expectCode(finishTask(cleaner, task.id), "photo_evidence_missing");
    expect((err.details as { missing: string[] }).missing).toEqual(["Nhà tắm"]);
    await attachRequiredPhotos(task.id, cleaner.userId!);
    await finishTask(cleaner, task.id);
  });
});
