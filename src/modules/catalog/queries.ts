import { query } from "@/lib/db";
import type { Actor } from "@/modules/auth/actor";

/** Danh mục nhà / tài nguyên vật lý / sản phẩm / listing theo kênh. Chỉ đọc, luôn lọc theo tổ chức. */

export interface CatalogProperty {
  id: string;
  code: string;
  name: string;
  address: string | null;
  timezone: string;
  check_in_from: string;
  check_in_until: string;
  check_out_at: string;
  default_clean_minutes: number;
  status: string;
  data_status: string;
  data_note: string | null;
  is_demo: boolean;
  updated_at: Date;
}

export interface CatalogResource {
  id: string;
  property_id: string;
  code: string;
  name: string;
  kind: string;
  active: boolean;
}

export interface CatalogUnit {
  id: string;
  property_id: string;
  code: string;
  name: string;
  kind: string;
  capacity: number;
  bed_config: string | null;
  clean_minutes: number | null;
  active: boolean;
  data_status: string;
  data_note: string | null;
  sort_order: number;
  is_demo: boolean;
  updated_at: Date;
  resource_ids: string[];
  alias_count: number;
}

export interface CatalogListing {
  id: string;
  unit_id: string;
  unit_code: string;
  property_id: string;
  channel: string;
  account_label: string | null;
  listing_name: string | null;
  external_listing_id: string | null;
  external_room_id: string | null;
  capacity_on_channel: number | null;
  status: string;
  data_status: string;
  data_note: string | null;
  is_demo: boolean;
  updated_at: Date;
}

export async function catalogOverview(actor: Actor) {
  const org = actor.orgId;
  const [properties, resources, units, listings] = await Promise.all([
    query<CatalogProperty>(
      `SELECT id, code, name, address, timezone, check_in_from::text, check_in_until::text, check_out_at::text, default_clean_minutes,
              status, data_status, data_note, is_demo, updated_at
         FROM properties WHERE org_id = $1 ORDER BY status = 'historical', code`,
      [org],
    ),
    query<CatalogResource>("SELECT id, property_id, code, name, kind, active FROM resources WHERE org_id = $1 ORDER BY code", [org]),
    query<CatalogUnit>(
      `SELECT u.id, u.property_id, u.code, u.name, u.kind, u.capacity, u.bed_config, u.clean_minutes, u.active, u.data_status, u.data_note,
              u.sort_order, u.is_demo, u.updated_at,
              coalesce((SELECT array_agg(ur.resource_id::text) FROM unit_resources ur WHERE ur.unit_id = u.id AND ur.org_id = $1), '{}') AS resource_ids,
              (SELECT count(*)::int FROM unit_aliases al WHERE al.unit_id = u.id AND al.org_id = $1) AS alias_count
         FROM units u WHERE u.org_id = $1 ORDER BY u.sort_order, u.code`,
      [org],
    ),
    query<CatalogListing>(
      `SELECT l.id, l.unit_id, u.code AS unit_code, u.property_id, l.channel, l.account_label, l.listing_name, l.external_listing_id, l.external_room_id,
              l.capacity_on_channel, l.status, l.data_status, l.data_note, l.is_demo, l.updated_at
         FROM channel_listings l JOIN units u ON u.id = l.unit_id
        WHERE l.org_id = $1 ORDER BY u.sort_order, u.code, l.channel`,
      [org],
    ),
  ]);

  const needsConfirmation = [
    ...properties.filter((p) => p.data_status === "needs_confirmation").map((p) => ({ type: "property" as const, id: p.id, code: p.code, label: p.name, note: p.data_note, updated_at: p.updated_at })),
    ...units.filter((u) => u.data_status === "needs_confirmation").map((u) => ({ type: "unit" as const, id: u.id, code: u.code, label: u.name, note: u.data_note, updated_at: u.updated_at })),
    ...listings
      .filter((l) => l.data_status === "needs_confirmation")
      .map((l) => ({ type: "listing" as const, id: l.id, code: l.unit_code, label: `${l.channel} · ${l.listing_name ?? "(chưa có tên listing)"}`, note: l.data_note, updated_at: l.updated_at })),
  ];

  return {
    properties: properties.map((p) => ({
      ...p,
      resources: resources.filter((r) => r.property_id === p.id),
      units: units.filter((u) => u.property_id === p.id),
      listings: listings.filter((l) => l.property_id === p.id),
    })),
    needsConfirmation,
    counts: { properties: properties.length, units: units.length, resources: resources.length, listings: listings.length },
  };
}

export type CatalogOverview = Awaited<ReturnType<typeof catalogOverview>>;
