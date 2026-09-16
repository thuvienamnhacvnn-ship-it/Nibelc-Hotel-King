import { pool, query, queryOne } from "@/lib/db";
import { invalid, notFound } from "@/lib/errors";
import { formatDateVi, isValidDate } from "@/lib/time";
import { type Actor, assertCan, can } from "@/modules/auth/actor";
import type { Permission } from "@/modules/auth/permissions";
import { findConflicts, type ClaimConflict } from "@/modules/inventory/inventory";
import type { ChangeCheck } from "./service";
import { BOOKING_STATUSES, CHANGE_KIND_LABELS, SOURCE_CHANNELS, STAY_STATUSES, type ChangeRequestPayload } from "./types";

/**
 * Truy vấn đọc cho màn hình Booking / Chờ duyệt. Chỉ đọc — mọi thay đổi đi qua service.ts.
 * Quyền xem liên hệ khách và số tiền được áp NGAY TRONG SQL (không chọn cột) để dữ liệu không rời máy chủ.
 */

// ───────────────────────── Bộ lọc danh sách ─────────────────────────

export const BOOKING_SORTS = {
  check_in_asc: { label: "Ngày nhận ↑", sql: "b.check_in_date ASC, b.created_at ASC" },
  check_in_desc: { label: "Ngày nhận ↓", sql: "b.check_in_date DESC, b.created_at DESC" },
  check_out_asc: { label: "Ngày trả ↑", sql: "b.check_out_date ASC, b.created_at ASC" },
  created_desc: { label: "Nhận booking mới nhất", sql: "coalesce(b.booking_created_at, b.created_at) DESC, b.id" },
  created_asc: { label: "Nhận booking cũ nhất", sql: "coalesce(b.booking_created_at, b.created_at) ASC, b.id" },
  ref_asc: { label: "Mã đặt phòng A→Z", sql: "b.external_ref ASC NULLS LAST, b.id" },
  updated_desc: { label: "Cập nhật gần nhất", sql: "b.updated_at DESC, b.id" },
} as const;
export type BookingSort = keyof typeof BOOKING_SORTS;

export interface BookingFilters {
  from: string | null;
  to: string | null;
  propertyId: string | null;
  unitId: string | null;
  channel: string | null;
  bookingStatus: string | null;
  stayStatus: string | null;
  pendingOnly: boolean;
  conflictOnly: boolean;
  q: string | null;
  sort: BookingSort;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | null | undefined): v is string => !!v && UUID_RE.test(v);

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;
function param(src: ParamSource, key: string): string | null {
  const v = src instanceof URLSearchParams ? src.get(key) : src[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
}

/** Tham số URL → bộ lọc hợp lệ. Giá trị lạ bị bỏ qua (không nối vào SQL). */
export function parseBookingFilters(src: ParamSource): BookingFilters {
  const from = param(src, "from");
  const to = param(src, "to");
  const pick = <T extends readonly string[]>(key: string, allowed: T) => {
    const v = param(src, key);
    return v && (allowed as readonly string[]).includes(v) ? v : null;
  };
  const sort = param(src, "sort");
  return {
    from: from && isValidDate(from) ? from : null,
    to: to && isValidDate(to) ? to : null,
    propertyId: isUuid(param(src, "property")) ? param(src, "property") : null,
    unitId: isUuid(param(src, "unit")) ? param(src, "unit") : null,
    channel: pick("channel", SOURCE_CHANNELS),
    bookingStatus: pick("status", BOOKING_STATUSES),
    stayStatus: pick("stay", STAY_STATUSES),
    pendingOnly: param(src, "pending") === "1",
    conflictOnly: param(src, "conflict") === "1",
    q: param(src, "q")?.slice(0, 100) ?? null,
    sort: sort && sort in BOOKING_SORTS ? (sort as BookingSort) : "check_in_asc",
  };
}

/** Bộ lọc → query string (dùng cho phân trang và link xuất Excel). */
export function filtersToQuery(f: BookingFilters, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.propertyId) p.set("property", f.propertyId);
  if (f.unitId) p.set("unit", f.unitId);
  if (f.channel) p.set("channel", f.channel);
  if (f.bookingStatus) p.set("status", f.bookingStatus);
  if (f.stayStatus) p.set("stay", f.stayStatus);
  if (f.pendingOnly) p.set("pending", "1");
  if (f.conflictOnly) p.set("conflict", "1");
  if (f.q) p.set("q", f.q);
  if (f.sort !== "check_in_asc") p.set("sort", f.sort);
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function buildWhere(actor: Actor, f: BookingFilters) {
  const params: unknown[] = [actor.orgId];
  const where: string[] = ["b.org_id = $1"];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    where.push(sql(params.length));
  };
  // Ngày ở giao khoảng [from, to] (ngày vận hành Budapest, tính theo đêm: nhận <= to và trả > from).
  if (f.from) add((n) => `b.check_out_date > $${n}::date`, f.from);
  if (f.to) add((n) => `b.check_in_date <= $${n}::date`, f.to);
  if (f.unitId) {
    add((n) => `EXISTS (SELECT 1 FROM booking_allocations a WHERE a.booking_id = b.id AND a.status IN ('active','conflict') AND a.unit_id = $${n})`, f.unitId);
  }
  if (f.propertyId) {
    add(
      (n) => `EXISTS (SELECT 1 FROM booking_allocations a JOIN units u ON u.id = a.unit_id WHERE a.booking_id = b.id AND a.status IN ('active','conflict') AND u.property_id = $${n})`,
      f.propertyId,
    );
  }
  if (f.channel) add((n) => `b.source_channel = $${n}`, f.channel);
  if (f.bookingStatus) add((n) => `b.booking_status = $${n}`, f.bookingStatus);
  if (f.stayStatus) add((n) => `b.stay_status = $${n}`, f.stayStatus);
  if (f.pendingOnly) where.push("EXISTS (SELECT 1 FROM change_requests cr WHERE cr.booking_id = b.id AND cr.status = 'pending')");
  if (f.conflictOnly) where.push("EXISTS (SELECT 1 FROM inventory_conflicts ic WHERE ic.booking_id = b.id AND ic.status = 'open')");
  if (f.q) {
    // Tìm theo tên khách chỉ khi được xem liên hệ khách — nếu không, tìm tên cũng làm lộ thông tin.
    if (can(actor, "booking.view_guest_contact")) add((n) => `(b.external_ref ILIKE $${n} OR g.full_name ILIKE $${n})`, likePattern(f.q));
    else add((n) => `b.external_ref ILIKE $${n}`, likePattern(f.q));
  }
  return { where: where.join(" AND "), params };
}

export interface AllocationView {
  id: string;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  unit_kind: string;
  property_code: string;
  start_date: string;
  end_date: string;
  guests: number | null;
  status: "active" | "released" | "conflict";
}

export interface BookingListItem {
  id: string;
  stt: number;
  booking_created_at: Date | null;
  created_at: Date;
  source_channel: string;
  source_account: string;
  external_ref: string | null;
  channel_note: string | null;
  ops_note: string | null;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  adults: number | null;
  children: number | null;
  total_guests: number | null;
  eta_local: string | null;
  booking_status: string;
  stay_status: string;
  payment_status: string;
  /** null khi không có quyền revenue.view */
  total_amount_minor: number | null;
  currency: string;
  last_synced_at: Date | null;
  source_updated_at: Date | null;
  is_demo: boolean;
  version: number;
  /** null khi không có quyền booking.view_guest_contact */
  guest_name: string | null;
  guest_phone: string | null;
  allocations: AllocationView[];
  pending_changes: number;
  open_conflicts: number;
}

function sensitiveColumns(actor: Actor) {
  const guest = can(actor, "booking.view_guest_contact");
  const money = can(actor, "revenue.view");
  return `${guest ? "g.full_name" : "NULL::text"} AS guest_name, ${guest ? "g.phone" : "NULL::text"} AS guest_phone,
          ${money ? "b.total_amount_minor" : "NULL::bigint"} AS total_amount_minor`;
}

const LIST_COLUMNS = `b.id, b.booking_created_at, b.created_at, b.source_channel, b.source_account, b.external_ref, b.channel_note, b.ops_note,
  b.check_in_date, b.check_out_date, (b.check_out_date - b.check_in_date)::int AS nights, b.adults, b.children, b.total_guests, b.eta_local,
  b.booking_status, b.stay_status, b.payment_status, b.currency, b.last_synced_at, b.source_updated_at, b.is_demo, b.version,
  (SELECT coalesce(json_agg(json_build_object('id', a.id, 'unit_id', u.id, 'unit_code', u.code, 'unit_name', u.name, 'unit_kind', u.kind,
            'property_code', p.code, 'start_date', a.start_date, 'end_date', a.end_date, 'guests', a.guests, 'status', a.status)
            ORDER BY a.start_date, u.code), '[]'::json)
     FROM booking_allocations a JOIN units u ON u.id = a.unit_id JOIN properties p ON p.id = u.property_id
    WHERE a.booking_id = b.id AND a.status IN ('active','conflict')) AS allocations,
  (SELECT count(*)::int FROM change_requests cr WHERE cr.booking_id = b.id AND cr.status = 'pending') AS pending_changes,
  (SELECT count(*)::int FROM inventory_conflicts ic WHERE ic.booking_id = b.id AND ic.status = 'open') AS open_conflicts`;

export async function listBookings(actor: Actor, f: BookingFilters, page: { page: number; pageSize: number; offset: number }) {
  assertCan(actor, "booking.view");
  const { where, params } = buildWhere(actor, f);
  const from = "FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id AND g.org_id = b.org_id";
  const totalRow = await queryOne<{ total: number }>(`SELECT count(*)::int AS total ${from} WHERE ${where}`, params);
  const rows = await query<Omit<BookingListItem, "stt">>(
    `SELECT ${LIST_COLUMNS}, ${sensitiveColumns(actor)} ${from} WHERE ${where}
      ORDER BY ${BOOKING_SORTS[f.sort].sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.pageSize, page.offset],
  );
  return {
    items: rows.map((r, i) => ({ ...r, stt: page.offset + i + 1 })) as BookingListItem[],
    page: page.page,
    pageSize: page.pageSize,
    total: totalRow?.total ?? 0,
  };
}

/** Nhà + căn/phòng của tổ chức (cho bộ lọc, form tạo booking, đổi phòng). */
export async function unitOptions(actor: Actor) {
  return query<{ id: string; code: string; name: string; kind: string; capacity: number; active: boolean; property_id: string; property_code: string; property_name: string; is_demo: boolean }>(
    `SELECT u.id, u.code, u.name, u.kind, u.capacity, u.active, u.property_id, p.code AS property_code, p.name AS property_name, u.is_demo
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.org_id = $1
      ORDER BY p.code, u.sort_order, u.code`,
    [actor.orgId],
  );
}
export type UnitOption = Awaited<ReturnType<typeof unitOptions>>[number];

export function propertiesOf(units: UnitOption[]) {
  const seen = new Map<string, { id: string; code: string; name: string }>();
  for (const u of units) if (!seen.has(u.property_id)) seen.set(u.property_id, { id: u.property_id, code: u.property_code, name: u.property_name });
  return [...seen.values()];
}

// ───────────────────────── Mô tả yêu cầu thay đổi ─────────────────────────

export function describeChange(payload: ChangeRequestPayload, unitCodes: Map<string, string>, allocationUnit: Map<string, string>): string {
  switch (payload.kind) {
    case "dates":
      return `Nhận ${formatDateVi(payload.checkInDate)} → trả ${formatDateVi(payload.checkOutDate)}`;
    case "move_unit": {
      const fromCode = allocationUnit.get(payload.allocationId) ?? "(phân bổ không còn)";
      const toCode = unitCodes.get(payload.toUnitId) ?? "(phòng không rõ)";
      return `${fromCode} → ${toCode}${payload.effectiveDate ? ` từ ${formatDateVi(payload.effectiveDate)}` : " (cả đoạn)"}`;
    }
    case "guests":
      return `${payload.adults} người lớn + ${payload.children ?? 0} trẻ em`;
    case "cancel":
      return `Hủy — lý do: ${payload.reason}`;
    case "late_checkout":
      return `Trả phòng lúc ${payload.time}`;
    case "early_checkin":
      return `Nhận phòng lúc ${payload.time}`;
    default:
      return CHANGE_KIND_LABELS[(payload as { kind: string }).kind] ?? "—";
  }
}

async function unitCodeMaps(actor: Actor, bookingIds: string[]) {
  const units = await query<{ id: string; code: string }>("SELECT id, code FROM units WHERE org_id = $1", [actor.orgId]);
  const allocs = bookingIds.length
    ? await query<{ id: string; code: string }>(
        "SELECT a.id, u.code FROM booking_allocations a JOIN units u ON u.id = a.unit_id WHERE a.org_id = $1 AND a.booking_id = ANY($2::uuid[])",
        [actor.orgId, bookingIds],
      )
    : [];
  return { unitCodes: new Map(units.map((u) => [u.id, u.code])), allocationUnit: new Map(allocs.map((a) => [a.id, a.code])) };
}

export interface ChangeRequestView {
  id: string;
  booking_id: string;
  booking_ref: string | null;
  booking_is_demo: boolean;
  source_channel: string;
  check_in_date: string;
  check_out_date: string;
  guest_name: string | null;
  booking_version: number;
  current_version: number;
  kind: string;
  payload: ChangeRequestPayload;
  description: string;
  source: string;
  status: string;
  note: string | null;
  check_result: ChangeCheck | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
}

export const CHANGE_REQUEST_STATUSES = ["pending", "applied", "rejected", "superseded", "failed"] as const;
export const CHANGE_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: "Chờ duyệt",
  applied: "Đã áp dụng",
  rejected: "Đã từ chối",
  superseded: "Hết hiệu lực (booking đã đổi)",
  failed: "Lỗi",
};
export const CHANGE_SOURCE_LABELS: Record<string, string> = {
  staff: "Nhân viên",
  guest_message: "Tin nhắn khách",
  connector: "Kênh bán",
  agent: "Trợ lý AI",
};

export async function listChangeRequests(actor: Actor, opts: { status?: string | null; bookingId?: string | null; limit?: number } = {}): Promise<ChangeRequestView[]> {
  assertCan(actor, "booking.view");
  const params: unknown[] = [actor.orgId];
  const where = ["cr.org_id = $1"];
  if (opts.status) {
    if (!(CHANGE_REQUEST_STATUSES as readonly string[]).includes(opts.status)) throw invalid("Trạng thái yêu cầu không hợp lệ.");
    params.push(opts.status);
    where.push(`cr.status = $${params.length}`);
  }
  if (opts.bookingId) {
    params.push(opts.bookingId);
    where.push(`cr.booking_id = $${params.length}`);
  }
  params.push(Math.min(opts.limit ?? 200, 500));
  const guest = can(actor, "booking.view_guest_contact");
  const rows = await query<Omit<ChangeRequestView, "description">>(
    `SELECT cr.id, cr.booking_id, b.external_ref AS booking_ref, b.is_demo AS booking_is_demo, b.source_channel, b.check_in_date, b.check_out_date,
            ${guest ? "g.full_name" : "NULL::text"} AS guest_name,
            cr.booking_version, b.version AS current_version, cr.kind, cr.payload, cr.source, cr.status, cr.note, cr.check_result,
            ru.full_name AS requested_by_name, du.full_name AS decided_by_name, cr.decided_at, cr.decision_note, cr.created_at
       FROM change_requests cr
       JOIN bookings b ON b.id = cr.booking_id AND b.org_id = cr.org_id
       LEFT JOIN guests g ON g.id = b.guest_id AND g.org_id = b.org_id
       LEFT JOIN users ru ON ru.id = cr.requested_by AND ru.org_id = cr.org_id
       LEFT JOIN users du ON du.id = cr.decided_by AND du.org_id = cr.org_id
      WHERE ${where.join(" AND ")}
      ORDER BY cr.status = 'pending' DESC, cr.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const maps = await unitCodeMaps(actor, [...new Set(rows.map((r) => r.booking_id))]);
  return rows.map((r) => ({ ...r, description: describeChange(r.payload, maps.unitCodes, maps.allocationUnit) }));
}

// ───────────────────────── Xung đột tồn ─────────────────────────

export interface ConflictView {
  id: string;
  booking_id: string;
  booking_ref: string | null;
  booking_is_demo: boolean;
  source_channel: string;
  guest_name: string | null;
  unit_code: string;
  property_code: string;
  start_date: string;
  end_date: string;
  status: string;
  resolution: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | null;
  created_at: Date;
  /** Những gì đang chiếm tồn lúc phát hiện (booking khác hoặc chặn tồn) */
  others: ClaimConflict[];
}

export async function listConflicts(actor: Actor, opts: { status?: string | null; bookingId?: string | null } = {}): Promise<ConflictView[]> {
  if (!can(actor, "booking.view") && !can(actor, "conflict.resolve")) assertCan(actor, "booking.view");
  const params: unknown[] = [actor.orgId];
  const where = ["ic.org_id = $1"];
  if (opts.status) {
    if (opts.status !== "open" && opts.status !== "resolved") throw invalid("Trạng thái xung đột không hợp lệ.");
    params.push(opts.status);
    where.push(`ic.status = $${params.length}`);
  }
  if (opts.bookingId) {
    params.push(opts.bookingId);
    where.push(`ic.booking_id = $${params.length}`);
  }
  const guest = can(actor, "booking.view_guest_contact");
  const rows = await query<Omit<ConflictView, "others"> & { detail: { conflicts?: ClaimConflict[] } | null }>(
    `SELECT ic.id, ic.booking_id, b.external_ref AS booking_ref, b.is_demo AS booking_is_demo, b.source_channel,
            ${guest ? "g.full_name" : "NULL::text"} AS guest_name,
            u.code AS unit_code, p.code AS property_code, ic.start_date, ic.end_date, ic.status, ic.resolution,
            ru.full_name AS resolved_by_name, ic.resolved_at, ic.created_at, ic.detail
       FROM inventory_conflicts ic
       JOIN bookings b ON b.id = ic.booking_id AND b.org_id = ic.org_id
       LEFT JOIN guests g ON g.id = b.guest_id AND g.org_id = b.org_id
       JOIN units u ON u.id = ic.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN users ru ON ru.id = ic.resolved_by AND ru.org_id = ic.org_id
      WHERE ${where.join(" AND ")}
      ORDER BY ic.status = 'open' DESC, ic.start_date, ic.created_at`,
    params,
  );
  return rows.map(({ detail, ...r }) => ({ ...r, others: detail?.conflicts ?? [] }));
}

// ───────────────────────── Kiểm tra chỗ trống ─────────────────────────

export async function checkAvailability(actor: Actor, input: { unitId: string | null; start: string | null; end: string | null; excludeBookingId?: string | null }) {
  const allowed: Permission[] = ["booking.create", "booking.request_change", "calendar.view", "booking.view"];
  if (!allowed.some((p) => can(actor, p))) assertCan(actor, "booking.create");
  if (!isUuid(input.unitId)) throw invalid("Thiếu hoặc sai unitId.");
  if (!input.start || !isValidDate(input.start) || !input.end || !isValidDate(input.end)) throw invalid("Ngày không hợp lệ (YYYY-MM-DD).");
  if (input.end <= input.start) throw invalid("Ngày trả phải sau ngày nhận.");
  const unit = await queryOne<{ id: string; code: string; capacity: number; active: boolean; kind: string }>(
    "SELECT id, code, capacity, active, kind FROM units WHERE id = $1 AND org_id = $2",
    [input.unitId, actor.orgId],
  );
  if (!unit) throw notFound("căn/phòng");
  let ignore: string[] = [];
  if (isUuid(input.excludeBookingId)) {
    const own = await query<{ id: string }>("SELECT id FROM booking_allocations WHERE booking_id = $1 AND org_id = $2 AND status IN ('active','conflict')", [
      input.excludeBookingId,
      actor.orgId,
    ]);
    ignore = own.map((a) => a.id);
  }
  const conflicts = await findConflicts(pool(), actor.orgId, unit.id, input.start, input.end, ignore);
  return { unit, start: input.start, end: input.end, available: conflicts.length === 0 && unit.active, conflicts };
}

// ───────────────────────── Chi tiết booking ─────────────────────────

export interface BookingChangeView {
  id: string;
  version: number;
  change_type: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_type: string;
  actor_name: string | null;
  source: string | null;
  source_ref: string | null;
  reason: string | null;
  created_at: Date;
}

/** Bỏ các trường nhạy cảm khỏi ảnh chụp trước/sau theo quyền người xem. */
function redactSnapshot(actor: Actor, snap: Record<string, unknown> | null) {
  if (!snap) return null;
  const out = { ...snap };
  if (!can(actor, "booking.view_guest_contact")) delete out.guest_name;
  if (!can(actor, "revenue.view")) {
    delete out.total_amount_minor;
    delete out.currency;
  }
  return out;
}

export async function getBookingDetail(actor: Actor, bookingId: string) {
  assertCan(actor, "booking.view");
  if (!isUuid(bookingId)) throw notFound("booking");
  const guest = can(actor, "booking.view_guest_contact");
  const booking = await queryOne<
    Omit<BookingListItem, "stt" | "allocations"> & {
      guest_email: string | null;
      guest_language: string | null;
      early_checkin_time: string | null;
      late_checkout_time: string | null;
      actual_check_in_at: Date | null;
      actual_check_out_at: Date | null;
      hold_expires_at: Date | null;
      updated_at: Date;
      created_by_name: string | null;
      allocations: AllocationView[];
    }
  >(
    `SELECT b.id, b.booking_created_at, b.created_at, b.updated_at, b.source_channel, b.source_account, b.external_ref, b.channel_note, b.ops_note,
            b.check_in_date, b.check_out_date, (b.check_out_date - b.check_in_date)::int AS nights, b.adults, b.children, b.total_guests, b.eta_local,
            b.booking_status, b.stay_status, b.payment_status, b.currency, b.last_synced_at, b.source_updated_at, b.is_demo, b.version,
            b.early_checkin_time::text, b.late_checkout_time::text, b.actual_check_in_at, b.actual_check_out_at, b.hold_expires_at,
            cu.full_name AS created_by_name,
            ${sensitiveColumns(actor)},
            ${guest ? "g.email" : "NULL::text"} AS guest_email, ${guest ? "g.language" : "NULL::text"} AS guest_language,
            (SELECT coalesce(json_agg(json_build_object('id', a.id, 'unit_id', u.id, 'unit_code', u.code, 'unit_name', u.name, 'unit_kind', u.kind,
                      'property_code', p.code, 'start_date', a.start_date, 'end_date', a.end_date, 'guests', a.guests, 'status', a.status,
                      'created_at', a.created_at, 'released_at', a.released_at)
                      ORDER BY a.start_date, a.created_at), '[]'::json)
               FROM booking_allocations a JOIN units u ON u.id = a.unit_id JOIN properties p ON p.id = u.property_id
              WHERE a.booking_id = b.id) AS allocations,
            (SELECT count(*)::int FROM change_requests cr WHERE cr.booking_id = b.id AND cr.status = 'pending') AS pending_changes,
            (SELECT count(*)::int FROM inventory_conflicts ic WHERE ic.booking_id = b.id AND ic.status = 'open') AS open_conflicts
       FROM bookings b
       LEFT JOIN guests g ON g.id = b.guest_id AND g.org_id = b.org_id
       LEFT JOIN users cu ON cu.id = b.created_by AND cu.org_id = b.org_id
      WHERE b.id = $1 AND b.org_id = $2`,
    [bookingId, actor.orgId],
  );
  if (!booking) throw notFound("booking");

  const changes = (
    await query<BookingChangeView>(
      `SELECT bc.id, bc.version, bc.change_type, bc.before, bc.after, bc.actor_type, u.full_name AS actor_name, bc.source, bc.source_ref, bc.reason, bc.created_at
         FROM booking_changes bc LEFT JOIN users u ON u.id = bc.actor_id AND u.org_id = bc.org_id
        WHERE bc.booking_id = $1 AND bc.org_id = $2
        ORDER BY bc.version DESC, bc.created_at DESC`,
      [bookingId, actor.orgId],
    )
  ).map((c) => ({ ...c, before: redactSnapshot(actor, c.before), after: redactSnapshot(actor, c.after) }));

  const [changeRequests, conflicts] = await Promise.all([
    listChangeRequests(actor, { bookingId, limit: 100 }),
    listConflicts(actor, { bookingId }),
  ]);

  const tasks = can(actor, "cleaning.view_all")
    ? await query<{ id: string; kind: string; status: string; service_date: string; due_at: Date; unit_code: string; assignee: string | null; role: "departing" | "arriving" }>(
        `SELECT t.id, t.kind, t.status, t.service_date, t.due_at, u.code AS unit_code, us.full_name AS assignee,
                CASE WHEN t.departing_booking_id = $1 THEN 'departing' ELSE 'arriving' END AS role
           FROM cleaning_tasks t JOIN units u ON u.id = t.unit_id LEFT JOIN users us ON us.id = t.assigned_to AND us.org_id = t.org_id
          WHERE t.org_id = $2 AND (t.departing_booking_id = $1 OR t.arriving_booking_id = $1)
          ORDER BY t.service_date, u.code`,
        [bookingId, actor.orgId],
      )
    : null;

  const audit = can(actor, "audit.view")
    ? await query<{ id: number; action: string; actor_type: string; actor_name: string | null; detail: Record<string, unknown> | null; created_at: Date }>(
        `SELECT al.id, al.action, al.actor_type, u.full_name AS actor_name, al.detail, al.created_at
           FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id AND u.org_id = al.org_id
          WHERE al.org_id = $1 AND al.entity_type = 'booking' AND al.entity_id = $2
          ORDER BY al.created_at DESC LIMIT 100`,
        [actor.orgId, bookingId],
      )
    : null;

  // Sức chứa nhỏ nhất theo đêm của phân bổ đang giữ — để xem trước yêu cầu đổi số khách.
  const cap = await queryOne<{ min_capacity: number | null }>(
    `SELECT min(cap)::int AS min_capacity FROM (
       SELECT d::date AS night, sum(u.capacity) AS cap
         FROM bookings b
         CROSS JOIN generate_series(b.check_in_date, b.check_out_date - 1, interval '1 day') AS d
         JOIN booking_allocations a ON a.booking_id = b.id AND a.status IN ('active','conflict') AND a.start_date <= d::date AND a.end_date > d::date
         JOIN units u ON u.id = a.unit_id
        WHERE b.id = $1 AND b.org_id = $2
        GROUP BY d) nights`,
    [bookingId, actor.orgId],
  );
  const times = await queryOne<{ check_in_from: string; check_out_at: string }>(
    `SELECT to_char(p.check_in_from, 'HH24:MI') AS check_in_from, to_char(p.check_out_at, 'HH24:MI') AS check_out_at
       FROM booking_allocations a JOIN units u ON u.id = a.unit_id JOIN properties p ON p.id = u.property_id
      WHERE a.booking_id = $1 AND a.org_id = $2 ORDER BY a.status = 'active' DESC LIMIT 1`,
    [bookingId, actor.orgId],
  );

  return {
    booking,
    changes,
    changeRequests,
    conflicts,
    tasks,
    audit,
    minCapacity: cap?.min_capacity ?? null,
    propertyTimes: { checkInFrom: times?.check_in_from ?? "15:00", checkOutAt: times?.check_out_at ?? "10:00" },
  };
}
export type BookingDetail = Awaited<ReturnType<typeof getBookingDetail>>;
