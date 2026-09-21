import { z } from "zod";
import { type Queryable, withTx } from "@/lib/db";
import { conflict, invalid, notFound } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/audit";
import { createAliasesInTx } from "./aliases";

/**
 * Nhập danh mục nhà/phòng THẬT từ một file JSON mô tả các chỗ nghỉ đang bán trên kênh (Booking.com, Airbnb…).
 *
 * Mô hình tồn giữ nguyên như phần còn lại của hệ thống: mỗi phòng vật lý là một `resource`; sản phẩm bán (`unit`)
 * gắn vào tài nguyên qua `unit_resources`. Nguyên căn gắn TẤT CẢ phòng của nhà ⇒ nguyên căn chặn phòng lẻ và ngược lại.
 *
 * Chạy lại nhiều lần an toàn: đối chiếu theo MÃ (`code`) trong tổ chức. Lần hai chỉ cập nhật tên / sức chứa /
 * tên-mã bên kênh; KHÔNG tạo bản ghi trùng, KHÔNG xoá gì.
 *
 * Quan hệ tài nguyên của sản phẩm ĐÃ TỒN TẠI thì không sửa: đổi `unit_resources` làm lệch tồn đã giữ
 * (`resource_claims`) — xem `src/modules/catalog/service.ts`. Thiếu liên kết chỉ được báo trong `warnings`.
 *
 * Mã `resources.code` và `units.code` duy nhất theo TỔ CHỨC (không theo nhà). Mã trong file trùng với bản ghi
 * đang thuộc NHÀ KHÁC ⇒ dừng bằng lỗi `invalid_input` trước khi ghi bất cứ thứ gì: dùng lại phòng vật lý của nhà
 * khác sẽ làm hai nhà chặn tồn lẫn nhau và rất khó gỡ (importer không được sửa quan hệ tài nguyên đã có).
 */

// ───────────────────────── Định dạng file JSON ─────────────────────────

const CHANNELS = ["airbnb", "booking_com", "direct", "other"] as const;

const codeField = z.string().trim().min(1, "Mã trống").max(64, "Mã dài quá 64 ký tự");
const nameField = z.string().trim().min(1, "Tên trống").max(200);
const capacityField = z.number().int().min(1, "Sức chứa tối thiểu 1").max(50, "Sức chứa tối đa 50");
const externalField = z.string().trim().min(1).max(200).nullish();

const roomSchema = z.object({
  code: codeField,
  name: nameField,
  kind: z.enum(["room", "studio"]).default("room"),
  capacity: capacityField,
  /** Mã phòng bên kênh nếu file nguồn có (Booking.com room id). Không có thì bỏ trống. */
  externalRoomId: externalField,
  externalRoomName: externalField,
});

const wholeUnitSchema = z.object({
  code: codeField,
  name: nameField,
  capacity: capacityField,
  externalRoomId: externalField,
  externalRoomName: externalField,
});

const propertySchema = z.object({
  code: codeField,
  name: nameField,
  address: z.string().trim().max(500).nullish(),
  /** Mã chỗ nghỉ bên kênh (Booking.com property id) — dùng chung cho mọi listing của nhà. */
  externalId: externalField,
  externalName: externalField,
  rooms: z.array(roomSchema).default([]),
  wholeUnit: wholeUnitSchema.nullish(),
});

export const otaCatalogFile = z.object({
  orgSlug: z.string().trim().min(1, "Thiếu orgSlug"),
  channel: z.enum(CHANNELS, { message: `Kênh phải là một trong: ${CHANNELS.join(", ")}` }),
  /**
   * Nhãn TÀI KHOẢN trên kênh (`connector_accounts.label`) — công ty có nhiều tài khoản trên cùng một kênh.
   * Khai thì listing được gắn `connector_id`; không khai thì listing để trống tài khoản như dữ liệu cũ.
   */
  accountLabel: z.string().trim().min(1).max(100).nullish(),
  properties: z.array(propertySchema).min(1, "File không có nhà nào"),
});

export type OtaCatalogFile = z.infer<typeof otaCatalogFile>;
export type OtaChannel = (typeof CHANNELS)[number];

/** Mã trong file có thể lẫn khoảng trắng do chép tay — bỏ mọi khoảng trắng, giữ nguyên chữ hoa/thường. */
function normCode(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/** Tài nguyên phòng đi kèm một sản phẩm, cùng quy ước đặt mã với importer docx. */
function resourceCodeOf(unitCode: string): string {
  return `R-${unitCode}`;
}

/**
 * Đọc + kiểm tra file. Ném `invalid` khi mã trùng nhau trong chính file (nguồn sai thì dừng, không đoán).
 */
export function parseOtaCatalog(raw: unknown): OtaCatalogFile {
  const file = otaCatalogFile.parse(raw);
  const properties = file.properties.map((p) => ({
    ...p,
    code: normCode(p.code),
    address: p.address?.trim() || null,
    externalId: p.externalId?.trim() || null,
    externalName: p.externalName?.trim() || null,
    rooms: p.rooms.map((r) => ({ ...r, code: normCode(r.code) })),
    wholeUnit: p.wholeUnit ? { ...p.wholeUnit, code: normCode(p.wholeUnit.code) } : null,
  }));

  const seenProperty = new Set<string>();
  const seenUnit = new Map<string, string>();
  for (const p of properties) {
    if (seenProperty.has(p.code)) throw invalid(`Mã nhà "${p.code}" xuất hiện hai lần trong file.`);
    seenProperty.add(p.code);
    if (!p.rooms.length && !p.wholeUnit) throw invalid(`Nhà "${p.code}" không có phòng nào và cũng không có nguyên căn.`);
    for (const u of [...p.rooms, ...(p.wholeUnit ? [p.wholeUnit] : [])]) {
      const owner = seenUnit.get(u.code);
      if (owner) throw invalid(`Mã sản phẩm "${u.code}" xuất hiện ở cả nhà ${owner} và nhà ${p.code}.`);
      seenUnit.set(u.code, p.code);
    }
  }
  return { ...file, properties };
}

// ───────────────────────── Bản kế hoạch (dùng cho cả dry-run lẫn ghi thật) ─────────────────────────

export type PlanAction = "create" | "update" | "unchanged";
export type Changes = Record<string, { from: unknown; to: unknown }>;

export interface ResourcePlan {
  code: string;
  name: string;
  kind: "room" | "studio";
  id: string | null;
  action: PlanAction;
  changes: Changes;
}

export interface ListingPlan {
  channel: OtaChannel;
  /** Tài khoản kênh đang bán listing (null = file không khai). */
  connectorId: string | null;
  accountLabel: string | null;
  listingName: string | null;
  externalListingId: string | null;
  externalRoomId: string | null;
  capacityOnChannel: number;
  status: "active" | "unknown";
  id: string | null;
  action: PlanAction;
  changes: Changes;
}

export interface UnitPlan {
  code: string;
  name: string;
  kind: "whole" | "room" | "studio";
  capacity: number;
  sortOrder: number;
  /** Tài nguyên sản phẩm phải gồm. Chỉ ghi khi sản phẩm được TẠO MỚI. */
  resourceCodes: string[];
  /** Sản phẩm đã có nhưng thiếu liên kết — chỉ báo, không tự sửa (đổi quan hệ làm lệch tồn đã giữ). */
  missingResourceCodes: string[];
  id: string | null;
  action: PlanAction;
  changes: Changes;
  listing: ListingPlan | null;
}

export interface PropertyPlan {
  code: string;
  name: string;
  address: string | null;
  id: string | null;
  action: PlanAction;
  changes: Changes;
  resources: ResourcePlan[];
  units: UnitPlan[];
}

export interface OtaCatalogPlan {
  orgId: string;
  orgSlug: string;
  channel: OtaChannel;
  connectorId: string | null;
  accountLabel: string | null;
  properties: PropertyPlan[];
  warnings: string[];
  counts: {
    properties: { create: number; update: number; unchanged: number };
    resources: { create: number; update: number; unchanged: number };
    units: { create: number; update: number; unchanged: number };
    listings: { create: number; update: number; unchanged: number };
  };
}

export interface OtaCatalogResult extends OtaCatalogPlan {
  dryRun: boolean;
  aliases: { created: number; collisions: number; takenByOtherUnit: number } | null;
}

function diffOf(before: Record<string, unknown>, after: Record<string, unknown>): Changes {
  const changes: Changes = {};
  for (const [k, v] of Object.entries(after)) if (v !== undefined && before[k] !== v) changes[k] = { from: before[k], to: v };
  return changes;
}

function tally(actions: PlanAction[]) {
  return {
    create: actions.filter((a) => a === "create").length,
    update: actions.filter((a) => a === "update").length,
    unchanged: actions.filter((a) => a === "unchanged").length,
  };
}

// ───────────────────────── Lập kế hoạch (chỉ ĐỌC) ─────────────────────────

interface OrgRow {
  id: string;
  slug: string;
  is_demo: boolean;
  timezone: string;
}

async function loadOrg(q: Queryable, orgSlug: string): Promise<OrgRow> {
  const { rows } = await q.query<OrgRow>("SELECT id, slug, is_demo, timezone FROM organizations WHERE slug = $1", [orgSlug]);
  const org = rows[0];
  if (!org) throw notFound(`tổ chức "${orgSlug}"`);
  if (org.is_demo) throw conflict("demo_org", "Tổ chức này là DEMO — không nhập danh mục thật vào dữ liệu mẫu.");
  return org;
}

/**
 * Sức chứa chỉ được GIẢM khi không có booking sắp tới đông khách hơn — cùng quy tắc với `updateUnit`.
 * Vướng thì giữ nguyên sức chứa cũ và báo trong `warnings` (importer không được phá ràng buộc của service).
 */
async function capacityBlockedBy(q: Queryable, orgId: string, unitId: string, newCapacity: number): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM booking_allocations a
       JOIN bookings b ON b.id = a.booking_id AND b.booking_status <> 'cancelled'
      WHERE a.org_id = $1 AND a.unit_id = $2 AND a.status = 'active'
        AND coalesce(a.guests, b.total_guests) > $3`,
    [orgId, unitId, newCapacity],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Tài khoản kênh mà file khai. Khai nhãn không có trong `connector_accounts` ⇒ dừng trước khi ghi:
 * tự tạo tài khoản ở đây sẽ đẻ ra tài khoản ma không ai cấu hình, còn bỏ qua thì listing gắn nhầm tài khoản.
 */
async function loadConnector(q: Queryable, orgId: string, channel: OtaChannel, accountLabel: string | null | undefined) {
  const label = accountLabel?.trim() || null;
  if (!label) return { connectorId: null, accountLabel: null };
  const { rows } = await q.query<{ id: string }>("SELECT id FROM connector_accounts WHERE org_id = $1 AND channel = $2 AND label = $3", [orgId, channel, label]);
  if (!rows[0]) throw notFound(`tài khoản kênh "${label}" của ${channel} — tạo tài khoản trong màn hình Kết nối rồi nhập lại`);
  return { connectorId: rows[0].id, accountLabel: label };
}

export async function planOtaCatalog(q: Queryable, file: OtaCatalogFile): Promise<OtaCatalogPlan> {
  const org = await loadOrg(q, file.orgSlug);
  const account = await loadConnector(q, org.id, file.channel, file.accountLabel);
  const warnings: string[] = [];
  const properties: PropertyPlan[] = [];

  for (const p of file.properties) {
    const externalId = p.externalId ?? null;
    const externalName = p.externalName ?? null;
    const { rows: propRows } = await q.query<{ id: string; name: string; address: string | null }>(
      "SELECT id, name, address FROM properties WHERE org_id = $1 AND code = $2",
      [org.id, p.code],
    );
    const existingProperty = propRows[0] ?? null;
    const propertyChanges = existingProperty
      ? diffOf({ name: existingProperty.name, address: existingProperty.address }, { name: p.name, address: p.address })
      : {};

    // Phòng vật lý: mỗi phòng lẻ một tài nguyên. Nhà chỉ bán nguyên căn thì chính nguyên căn là một tài nguyên.
    const wantedResources = p.rooms.map((r) => ({ code: resourceCodeOf(r.code), name: r.name, kind: r.kind }));
    if (!wantedResources.length && p.wholeUnit) {
      wantedResources.push({ code: resourceCodeOf(p.wholeUnit.code), name: p.wholeUnit.name, kind: "studio" as const });
      warnings.push(`${p.code}: nhà không khai phòng lẻ — nguyên căn ${p.wholeUnit.code} tự là một tài nguyên.`);
    }

    // `resources.code` duy nhất theo TỔ CHỨC, không theo nhà: phải kiểm cả `property_id`, nếu không sẽ dùng lại
    // phòng vật lý của nhà khác và hai nhà chặn tồn lẫn nhau vĩnh viễn (importer không được sửa unit_resources).
    const { rows: resourceRows } = await q.query<{ id: string; code: string; name: string; property_id: string; property_code: string }>(
      `SELECT r.id, r.code, r.name, r.property_id, p.code AS property_code
         FROM resources r JOIN properties p ON p.id = r.property_id
        WHERE r.org_id = $1 AND r.code = ANY($2::text[])`,
      [org.id, wantedResources.map((r) => r.code)],
    );
    const resourceByCode = new Map(resourceRows.map((r) => [r.code, r]));
    const resources: ResourcePlan[] = wantedResources.map((r) => {
      const existing = resourceByCode.get(r.code);
      if (existing && existing.property_id !== existingProperty?.id) {
        throw invalid(
          `Phòng vật lý "${r.code}" đã thuộc nhà ${existing.property_code}, không phải nhà ${p.code}. Mã tài nguyên duy nhất trong cả tổ chức — dùng lại sẽ làm hai nhà chặn tồn lẫn nhau. Đổi mã phòng trong file rồi nhập lại; chưa ghi gì.`,
        );
      }
      const changes = existing ? diffOf({ name: existing.name }, { name: r.name }) : {};
      return {
        ...r,
        id: existing?.id ?? null,
        action: !existing ? "create" : Object.keys(changes).length ? "update" : "unchanged",
        changes,
      };
    });

    const wanted: { code: string; name: string; kind: UnitPlan["kind"]; capacity: number; resourceCodes: string[]; externalRoomId: string | null; externalRoomName: string | null }[] =
      p.rooms.map((r) => ({
        code: r.code,
        name: r.name,
        kind: r.kind,
        capacity: r.capacity,
        resourceCodes: [resourceCodeOf(r.code)],
        externalRoomId: r.externalRoomId?.trim() || null,
        externalRoomName: r.externalRoomName?.trim() || null,
      }));
    if (p.wholeUnit) {
      wanted.push({
        code: p.wholeUnit.code,
        name: p.wholeUnit.name,
        kind: "whole",
        capacity: p.wholeUnit.capacity,
        // Nguyên căn gồm MỌI phòng vật lý của nhà ⇒ chặn chéo với phòng lẻ.
        resourceCodes: wantedResources.map((r) => r.code),
        externalRoomId: p.wholeUnit.externalRoomId?.trim() || null,
        externalRoomName: p.wholeUnit.externalRoomName?.trim() || null,
      });
    }

    const { rows: unitRows } = await q.query<{ id: string; code: string; name: string; capacity: number; kind: string; property_id: string; property_code: string }>(
      `SELECT u.id, u.code, u.name, u.capacity, u.kind, u.property_id, p.code AS property_code
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.org_id = $1 AND u.code = ANY($2::text[])`,
      [org.id, wanted.map((u) => u.code)],
    );
    const unitByCode = new Map(unitRows.map((u) => [u.code, u]));

    const units: UnitPlan[] = [];
    for (const [index, u] of wanted.entries()) {
      const existing = unitByCode.get(u.code) ?? null;
      let capacity = u.capacity;
      let missingResourceCodes: string[] = [];

      if (existing) {
        if (existing.property_id !== existingProperty?.id) {
          // Cùng lý do với tài nguyên: đổi tên / gắn listing cho sản phẩm của nhà khác là hỏng dữ liệu, không phải cảnh báo.
          throw invalid(
            `Sản phẩm "${u.code}" đã thuộc nhà ${existing.property_code}, không phải nhà ${p.code}. Mã sản phẩm duy nhất trong cả tổ chức — đổi mã trong file rồi nhập lại; chưa ghi gì.`,
          );
        }
        if (existing.kind !== u.kind) {
          warnings.push(`${u.code}: loại đang là "${existing.kind}" trong DB nhưng file ghi "${u.kind}" — không tự đổi loại.`);
        }
        if (capacity < existing.capacity) {
          const blocked = await capacityBlockedBy(q, org.id, existing.id, capacity);
          if (blocked) {
            warnings.push(`${u.code}: giữ sức chứa ${existing.capacity} (file ghi ${capacity}) vì còn ${blocked} phân bổ có nhiều khách hơn.`);
            capacity = existing.capacity;
          }
        }
        const { rows: linked } = await q.query<{ code: string }>(
          "SELECT r.code FROM unit_resources ur JOIN resources r ON r.id = ur.resource_id WHERE ur.unit_id = $1 AND ur.org_id = $2",
          [existing.id, org.id],
        );
        const have = new Set(linked.map((r) => r.code));
        missingResourceCodes = u.resourceCodes.filter((c) => !have.has(c));
        if (missingResourceCodes.length) {
          warnings.push(
            `${u.code}: đã có sẵn nhưng thiếu liên kết tới ${missingResourceCodes.join(", ")} — importer KHÔNG đổi quan hệ tài nguyên của sản phẩm đã tồn tại (đổi sẽ lệch tồn đã giữ). Cần xử lý tay.`,
          );
        }
      }

      const unitChanges = existing ? diffOf({ name: existing.name, capacity: existing.capacity }, { name: u.name, capacity }) : {};

      // Listing chỉ ghi khi file có thứ để liên kết sang kênh; không có thì bỏ qua và báo.
      const listingName = u.externalRoomName ?? (u.kind === "whole" ? externalName : null);
      const hasChannelInfo = Boolean(externalId || listingName || u.externalRoomId);
      let listing: ListingPlan | null = null;
      if (!hasChannelInfo) {
        warnings.push(`${u.code}: file không có mã/tên bên kênh — chưa tạo listing ${file.channel}.`);
      } else {
        const wantedListing = {
          listing_name: listingName,
          external_listing_id: externalId,
          external_room_id: u.externalRoomId,
          capacity_on_channel: u.capacity,
          account_label: account.accountLabel,
          connector_id: account.connectorId,
        };
        // Một sản phẩm có thể có nhiều listing cùng kênh (mỗi tài khoản một cái): ưu tiên listing đúng tài khoản,
        // không có thì nhận listing chưa gắn tài khoản (dữ liệu cũ) và gắn vào — chạy lại lần hai không đẻ bản ghi mới.
        const existingListing = existing
          ? (
              await q.query<{
                id: string;
                listing_name: string | null;
                external_listing_id: string | null;
                external_room_id: string | null;
                capacity_on_channel: number | null;
                account_label: string | null;
                connector_id: string | null;
              }>(
                `SELECT id, listing_name, external_listing_id, external_room_id, capacity_on_channel, account_label, connector_id
                   FROM channel_listings
                  WHERE org_id = $1 AND unit_id = $2 AND channel = $3
                    AND ($4::uuid IS NULL OR connector_id IS NULL OR connector_id = $4)
                  ORDER BY (connector_id IS NOT DISTINCT FROM $4::uuid) DESC, created_at LIMIT 1`,
                [org.id, existing.id, file.channel, account.connectorId],
              )
            ).rows[0] ?? null
          : null;
        const listingChanges = existingListing ? diffOf(existingListing as unknown as Record<string, unknown>, wantedListing) : {};
        listing = {
          channel: file.channel,
          connectorId: account.connectorId,
          accountLabel: account.accountLabel,
          listingName,
          externalListingId: externalId,
          externalRoomId: u.externalRoomId,
          capacityOnChannel: u.capacity,
          status: externalId ? "active" : "unknown",
          id: existingListing?.id ?? null,
          action: !existingListing ? "create" : Object.keys(listingChanges).length ? "update" : "unchanged",
          changes: listingChanges,
        };
      }

      units.push({
        code: u.code,
        name: u.name,
        kind: u.kind,
        capacity,
        sortOrder: index,
        resourceCodes: u.resourceCodes,
        missingResourceCodes,
        id: existing?.id ?? null,
        action: !existing ? "create" : Object.keys(unitChanges).length ? "update" : "unchanged",
        changes: unitChanges,
        listing,
      });
    }

    properties.push({
      code: p.code,
      name: p.name,
      address: p.address ?? null,
      id: existingProperty?.id ?? null,
      action: !existingProperty ? "create" : Object.keys(propertyChanges).length ? "update" : "unchanged",
      changes: propertyChanges,
      resources,
      units,
    });
  }

  const allUnits = properties.flatMap((p) => p.units);
  return {
    orgId: org.id,
    orgSlug: org.slug,
    channel: file.channel,
    connectorId: account.connectorId,
    accountLabel: account.accountLabel,
    properties,
    warnings,
    counts: {
      properties: tally(properties.map((p) => p.action)),
      resources: tally(properties.flatMap((p) => p.resources.map((r) => r.action))),
      units: tally(allUnits.map((u) => u.action)),
      listings: tally(allUnits.flatMap((u) => (u.listing ? [u.listing.action] : []))),
    },
  };
}

// ───────────────────────── Ghi vào tổ chức ─────────────────────────

const auditActor = (orgId: string) => ({ orgId, actorType: "system", actorId: null });
const ACTION = "catalog.ota_import";

async function writePlan(tx: Queryable, plan: OtaCatalogPlan, timezone: string) {
  for (const p of plan.properties) {
    let propertyId = p.id;
    if (p.action === "create") {
      propertyId = (
        await tx.query<{ id: string }>(
          `INSERT INTO properties (org_id, code, name, address, timezone, data_status, data_note)
           VALUES ($1,$2,$3,$4,$5,'needs_confirmation',$6) RETURNING id`,
          [plan.orgId, p.code, p.name, p.address, timezone, `Nhập từ danh mục kênh ${plan.channel} (JSON)`],
        )
      ).rows[0].id;
      await writeAudit(tx, auditActor(plan.orgId), ACTION, "property", propertyId, { code: p.code, created: true });
    } else if (p.action === "update") {
      await tx.query("UPDATE properties SET name = $3, address = coalesce($4, address), updated_at = now() WHERE id = $1 AND org_id = $2", [
        propertyId,
        plan.orgId,
        p.name,
        p.address,
      ]);
      await writeAudit(tx, auditActor(plan.orgId), ACTION, "property", propertyId, { code: p.code, changes: p.changes });
    }

    const resourceIds = new Map<string, string>();
    for (const r of p.resources) {
      if (r.action === "create") {
        const id = (
          await tx.query<{ id: string }>("INSERT INTO resources (org_id, property_id, code, name, kind) VALUES ($1,$2,$3,$4,$5) RETURNING id", [
            plan.orgId,
            propertyId,
            r.code,
            r.name,
            r.kind,
          ])
        ).rows[0].id;
        resourceIds.set(r.code, id);
        await writeAudit(tx, auditActor(plan.orgId), ACTION, "resource", id, { code: r.code, created: true });
      } else {
        resourceIds.set(r.code, r.id!);
        if (r.action === "update") {
          await tx.query("UPDATE resources SET name = $3 WHERE id = $1 AND org_id = $2", [r.id, plan.orgId, r.name]);
          await writeAudit(tx, auditActor(plan.orgId), ACTION, "resource", r.id, { code: r.code, changes: r.changes });
        }
      }
    }

    for (const u of p.units) {
      let unitId = u.id;
      if (u.action === "create") {
        unitId = (
          await tx.query<{ id: string }>(
            `INSERT INTO units (org_id, property_id, code, name, kind, capacity, data_status, data_note, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,'needs_confirmation',$7,$8) RETURNING id`,
            [plan.orgId, propertyId, u.code, u.name, u.kind, u.capacity, `Nhập từ danh mục kênh ${plan.channel} (JSON)`, u.sortOrder],
          )
        ).rows[0].id;
        // Quan hệ tài nguyên chỉ ghi lúc tạo — sản phẩm đã tồn tại thì không đụng (tồn đã giữ).
        for (const code of u.resourceCodes) {
          const resourceId = resourceIds.get(code);
          if (!resourceId) continue;
          await tx.query("INSERT INTO unit_resources (unit_id, resource_id, org_id) VALUES ($1,$2,$3)", [unitId, resourceId, plan.orgId]);
        }
        await writeAudit(tx, auditActor(plan.orgId), ACTION, "unit", unitId, { code: u.code, created: true, resources: u.resourceCodes });
      } else if (u.action === "update") {
        await tx.query("UPDATE units SET name = $3, capacity = $4, updated_at = now() WHERE id = $1 AND org_id = $2", [unitId, plan.orgId, u.name, u.capacity]);
        await writeAudit(tx, auditActor(plan.orgId), ACTION, "unit", unitId, { code: u.code, changes: u.changes });
      }

      const l = u.listing;
      if (!l || l.action === "unchanged") continue;
      if (l.action === "create") {
        const id = (
          await tx.query<{ id: string }>(
            `INSERT INTO channel_listings (org_id, unit_id, channel, connector_id, account_label, listing_name, external_listing_id, external_room_id, capacity_on_channel, status, data_status, data_note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'needs_confirmation',$11) RETURNING id`,
            [
              plan.orgId,
              unitId,
              l.channel,
              l.connectorId,
              l.accountLabel,
              l.listingName,
              l.externalListingId,
              l.externalRoomId,
              l.capacityOnChannel,
              l.status,
              `Nhập từ danh mục kênh ${plan.channel} (JSON)`,
            ],
          )
        ).rows[0].id;
        await writeAudit(tx, auditActor(plan.orgId), ACTION, "channel_listing", id, { unitCode: u.code, channel: l.channel, accountLabel: l.accountLabel, created: true });
      } else {
        // Tài khoản chỉ ghi đè khi file khai — file không khai thì giữ nguyên tài khoản đã gắn trước đó.
        await tx.query(
          `UPDATE channel_listings SET listing_name = $3, external_listing_id = coalesce($4, external_listing_id),
                  external_room_id = coalesce($5, external_room_id), capacity_on_channel = $6,
                  connector_id = coalesce($7, connector_id), account_label = coalesce($8, account_label), updated_at = now()
            WHERE id = $1 AND org_id = $2`,
          [l.id, plan.orgId, l.listingName, l.externalListingId, l.externalRoomId, l.capacityOnChannel, l.connectorId, l.accountLabel],
        );
        await writeAudit(tx, auditActor(plan.orgId), ACTION, "channel_listing", l.id, { unitCode: u.code, channel: l.channel, accountLabel: l.accountLabel, changes: l.changes });
      }
    }
  }
}

/**
 * Lập kế hoạch rồi (nếu không phải dry-run) ghi. Mọi thứ nằm trong một giao dịch: đọc — kiểm — ghi,
 * theo lối "kiểm trước rồi ghi" vì PGlite lệch giao thức khi một câu lệnh có tham số bị lỗi.
 */
export async function importOtaCatalog(file: OtaCatalogFile, opts: { dryRun?: boolean } = {}): Promise<OtaCatalogResult> {
  const dryRun = opts.dryRun ?? false;
  return withTx(async (tx) => {
    const org = await loadOrg(tx, file.orgSlug);
    // Cùng khoá với importer docx: hai lần nhập danh mục không chạy chồng lên nhau.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7342))", [`catalog|${org.id}`]);
    const plan = await planOtaCatalog(tx, file);
    if (dryRun) return { ...plan, dryRun: true, aliases: null };

    await writePlan(tx, plan, org.timezone);
    // Alias tên nội bộ → mã sản phẩm, để importer Excel tra được phòng. Hàm này tự bỏ qua alias đã có.
    const aliases = await createAliasesInTx(tx, org.id);
    const result: OtaCatalogResult = {
      ...plan,
      dryRun: false,
      aliases: { created: aliases.created.length, collisions: aliases.collisions.length, takenByOtherUnit: aliases.takenByOtherUnit.length },
    };
    await writeAudit(tx, auditActor(org.id), ACTION, "organization", org.id, {
      channel: plan.channel,
      accountLabel: plan.accountLabel,
      counts: plan.counts,
      warnings: plan.warnings.length,
      aliases: result.aliases,
    });
    return result;
  });
}
