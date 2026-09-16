import crypto from "node:crypto";
import { afterAll } from "vitest";
import { closePool, query, queryOne } from "@/lib/db";
import { type Actor, userActor } from "@/modules/auth/actor";
import type { Role } from "@/modules/auth/permissions";
import { drainOutbox } from "@/modules/outbox/outbox";
import { handlers } from "@/worker/handlers";

afterAll(async () => {
  await closePool();
});

export const uid = () => crypto.randomBytes(4).toString("hex");

export interface Fixture {
  orgId: string;
  actors: Record<Role, Actor>;
  cleaners: Actor[];
  propertyId: string;
  units: { whole: string; r1: string; r2: string; r3: string; studio: string };
  resources: { r1: string; r2: string; r3: string; studio: string };
  connectorId: string;
}

/**
 * Một tổ chức thử độc lập cho mỗi ca kiểm thử: nhà có nguyên căn W (3 phòng R1, R2, R3) và một studio S riêng.
 * Mã có hậu tố ngẫu nhiên nên các ca không giẫm lên nhau trong cùng database thử.
 */
export async function makeFixture(): Promise<Fixture> {
  const s = uid();
  const org = await queryOne<{ id: string }>("INSERT INTO organizations (slug, name, is_demo) VALUES ($1,$2,true) RETURNING id", [`t-${s}`, `Thử ${s}`]);
  const orgId = org!.id;
  const roles: Role[] = ["admin", "vn_manager", "vn_staff", "bp_coordinator", "bp_staff", "cleaner", "manager_viewer"];
  const actors = {} as Record<Role, Actor>;
  for (const role of roles) {
    const u = await queryOne<{ id: string }>(
      "INSERT INTO users (org_id, email, full_name, role, password_hash, is_demo) VALUES ($1,$2,$3,$4,'x',true) RETURNING id",
      [orgId, `${role}-${s}@test.local`, `${role} ${s}`, role],
    );
    actors[role] = userActor({ userId: u!.id, orgId, role, fullName: role, timezone: "Europe/Budapest" });
  }
  const cleaners: Actor[] = [actors.cleaner];
  const second = await queryOne<{ id: string }>(
    "INSERT INTO users (org_id, email, full_name, role, password_hash, is_demo) VALUES ($1,$2,'cleaner 2','cleaner','x',true) RETURNING id",
    [orgId, `cleaner2-${s}@test.local`],
  );
  cleaners.push(userActor({ userId: second!.id, orgId, role: "cleaner", fullName: "cleaner 2", timezone: "Europe/Budapest" }));
  for (const c of cleaners) await query("INSERT INTO cleaner_profiles (user_id, org_id) VALUES ($1,$2)", [c.userId, orgId]);

  const prop = await queryOne<{ id: string }>("INSERT INTO properties (org_id, code, name) VALUES ($1,$2,'Nhà thử') RETURNING id", [orgId, `P-${s}`]);
  const propertyId = prop!.id;
  const res = async (code: string, kind = "room") =>
    (await queryOne<{ id: string }>("INSERT INTO resources (org_id, property_id, code, name, kind) VALUES ($1,$2,$3,$3,$4) RETURNING id", [orgId, propertyId, `${code}-${s}`, kind]))!.id;
  const resources = { r1: await res("R1"), r2: await res("R2"), r3: await res("R3"), studio: await res("S", "studio") };
  const unit = async (code: string, kind: string, capacity: number, resIds: string[]) => {
    const u = await queryOne<{ id: string }>("INSERT INTO units (org_id, property_id, code, name, kind, capacity) VALUES ($1,$2,$3,$3,$4,$5) RETURNING id", [
      orgId,
      propertyId,
      `${code}-${s}`,
      kind,
      capacity,
    ]);
    for (const r of resIds) await query("INSERT INTO unit_resources (unit_id, resource_id, org_id) VALUES ($1,$2,$3)", [u!.id, r, orgId]);
    return u!.id;
  };
  const units = {
    whole: await unit("W", "whole", 8, [resources.r1, resources.r2, resources.r3]),
    r1: await unit("R1", "room", 2, [resources.r1]),
    r2: await unit("R2", "room", 3, [resources.r2]),
    r3: await unit("R3", "room", 3, [resources.r3]),
    studio: await unit("S", "studio", 4, [resources.studio]),
  };
  await query(
    `INSERT INTO checklist_templates (org_id, property_id, name, items) VALUES ($1,$2,'Checklist thử',$3)`,
    [orgId, propertyId, JSON.stringify([{ key: "bed", label: "Giường" }, { key: "bath", label: "Nhà tắm", requiresPhoto: true }])],
  );
  await query("INSERT INTO channel_listings (org_id, unit_id, channel, external_listing_id) VALUES ($1,$2,'airbnb',$3)", [orgId, units.r1, `AB-R1-${s}`]);
  await query("INSERT INTO channel_listings (org_id, unit_id, channel, external_listing_id) VALUES ($1,$2,'airbnb',$3)", [orgId, units.whole, `AB-W-${s}`]);
  const conn = await queryOne<{ id: string }>("INSERT INTO connector_accounts (org_id, channel, label, status) VALUES ($1,'airbnb','Demo Airbnb','demo') RETURNING id", [orgId]);
  return { orgId, actors, cleaners, propertyId, units, resources, connectorId: conn!.id };
}

export function bookingInput(unitIds: string | string[], checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) {
  const ids = Array.isArray(unitIds) ? unitIds : [unitIds];
  return {
    sourceChannel: "manual",
    guest: { fullName: "Khách thử" },
    checkInDate: checkIn,
    checkOutDate: checkOut,
    allocations: ids.map((unitId) => ({ unitId })),
    ...extra,
  };
}

/** Chạy worker một lượt (đồng bộ) để các hệ quả của outbox xuất hiện. */
export async function runWorker() {
  return drainOutbox(handlers);
}

export async function tasksFor(orgId: string) {
  return query<{ id: string; unit_id: string; status: string; kind: string; service_date: string; due_at: Date; change_ack_required: boolean; pending_change: unknown; version: number; departing_booking_id: string }>(
    "SELECT id, unit_id, status, kind, service_date, due_at, change_ack_required, pending_change, version, departing_booking_id FROM cleaning_tasks WHERE org_id = $1 ORDER BY service_date, created_at",
    [orgId],
  );
}

export async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) throw new Error(`Mong đợi lỗi ${code}, nhận ${actual}: ${(error as Error).message}`);
    return error as { code: string; details?: unknown; message: string };
  }
  throw new Error(`Mong đợi lỗi ${code} nhưng thao tác thành công`);
}

/** Gắn ảnh giả (chỉ bản ghi, không file) cho mọi mục checklist cần ảnh — để test luồng hoàn thành. */
export async function attachRequiredPhotos(taskId: string, uploaderUserId: string) {
  const items = await query<{ id: string; org_id: string; unit_id: string }>(
    `SELECT i.id, i.org_id, t.unit_id FROM task_checklist_items i JOIN cleaning_tasks t ON t.id = i.task_id WHERE i.task_id = $1 AND i.requires_photo`,
    [taskId],
  );
  for (const it of items) {
    await query(
      `INSERT INTO task_photos (org_id, task_id, checklist_item_id, unit_id, storage_key, mime_type, bytes, sha256, client_upload_id, uploaded_by)
       VALUES ($1,$2,$3,$4,'test/none.jpg','image/jpeg',1000,$5,$6,$7)`,
      [it.org_id, taskId, it.id, it.unit_id, `sha-${uid()}`, `test-${uid()}`, uploaderUserId],
    );
  }
}
