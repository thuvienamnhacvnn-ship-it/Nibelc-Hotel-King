import { type Queryable, query, queryOne, withTx } from "@/lib/db";
import { conflict, invalid, notFound } from "@/lib/errors";
import { addDays, now, todayOps } from "@/lib/time";
import { auditActorOf, writeAudit } from "@/modules/audit/audit";
import { type Actor, assertCan } from "@/modules/auth/actor";
import { maskUrl, nightsOf, parseIcal, toRanges } from "./parse";

/**
 * Connector iCal chỉ đọc. Không tạo/sửa booking từ iCal (không đủ dữ liệu) — chỉ ghi phát hiện lệch lịch.
 * Link chỉ được lấy từ tên miền của kênh (chống dùng hệ thống gọi địa chỉ nội bộ).
 */
// Chỉ tên miền thật của kênh: airbnb.<đuôi quốc gia> (không cho airbnb.com.evil.test) và *.booking.com
const ALLOWED_HOSTS = [/^(www\.)?airbnb\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i, /^([a-z0-9-]+\.)*booking\.com$/i];
const WINDOW_DAYS = 365;
const MAX_BYTES = 2 * 1024 * 1024;
/** Booking mới tạo cần thời gian để kênh kia nhập lịch — trong khoảng này chưa báo "kênh còn trống". */
const GRACE_HOURS = 4;

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: string }>;

/** Không tự đi theo chuyển hướng: mỗi bước chuyển hướng phải lại là https của Airbnb/Booking.com (chống bị dẫn tới địa chỉ nội bộ). */
export const defaultFetcher: Fetcher = async (url) => {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": "VD-Hotel-ical/1.0" } });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Kênh chuyển hướng không có địa chỉ (mã ${res.status})`);
      current = validateIcalUrl(new URL(location, current).toString());
      continue;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error("Tệp iCal quá lớn");
    return { ok: res.ok, status: res.status, text: new TextDecoder().decode(buf) };
  }
  throw new Error("Kênh chuyển hướng quá nhiều lần");
};

export function validateIcalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw invalid("Link iCal không hợp lệ.");
  }
  if (u.protocol !== "https:") throw invalid("Link iCal phải là https.");
  if (u.username || u.password || u.port) throw invalid("Link iCal không được có tài khoản hay cổng riêng.");
  if (!ALLOWED_HOSTS.some((re) => re.test(u.hostname))) throw invalid("Chỉ nhận link xuất lịch của Airbnb hoặc Booking.com.");
  return u.toString();
}

export async function addIcalFeed(actor: Actor, input: { listingId: string; url: string }) {
  assertCan(actor, "connector.manage");
  const url = validateIcalUrl(input.url);
  return withTx(async (tx) => {
    const listing = await tx.query<{ id: string; channel: string }>("SELECT id, channel FROM channel_listings WHERE id = $1 AND org_id = $2", [input.listingId, actor.orgId]);
    if (!listing.rows[0]) throw notFound("listing");
    const exists = await tx.query("SELECT 1 FROM ical_feeds WHERE org_id = $1 AND listing_id = $2", [actor.orgId, input.listingId]);
    if (exists.rows.length) throw conflict("feed_exists", "Listing này đã có link iCal. Xoá link cũ trước khi thay.");
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO ical_feeds (org_id, listing_id, url_secret, url_hint, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [actor.orgId, input.listingId, url, maskUrl(url), actor.userId],
    );
    // Không ghi link vào nhật ký — chỉ ghi dạng che.
    await writeAudit(tx, auditActorOf(actor), "ical.feed_add", "channel_listing", input.listingId, { hint: maskUrl(url) });
    return { id: rows[0].id };
  });
}

export async function removeIcalFeed(actor: Actor, feedId: string) {
  assertCan(actor, "connector.manage");
  const row = await queryOne<{ listing_id: string }>("DELETE FROM ical_feeds WHERE id = $1 AND org_id = $2 RETURNING listing_id", [feedId, actor.orgId]);
  if (!row) throw notFound("link iCal");
  await writeAudit(null, auditActorOf(actor), "ical.feed_remove", "channel_listing", row.listing_id, {});
  return { ok: true };
}

interface FeedRow {
  id: string;
  org_id: string;
  listing_id: string;
  url_secret: string;
  unit_id: string;
  timezone: string;
}

/** Đồng bộ một link: tải, đọc, đối chiếu, cập nhật phát hiện. Lỗi tải ⇒ ghi last_error, không đụng phát hiện cũ. */
export async function syncFeed(feedId: string, fetcher: Fetcher = defaultFetcher) {
  const feed = await queryOne<FeedRow>(
    `SELECT f.id, f.org_id, f.listing_id, f.url_secret, l.unit_id, p.timezone
       FROM ical_feeds f JOIN channel_listings l ON l.id = f.listing_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
      WHERE f.id = $1`,
    [feedId],
  );
  if (!feed) throw notFound("link iCal");
  await query("UPDATE ical_feeds SET last_attempt_at = now() WHERE id = $1", [feedId]);
  let text: string;
  try {
    const res = await fetcher(feed.url_secret);
    if (!res.ok) throw new Error(`Kênh trả mã ${res.status}`);
    text = res.text;
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Nội dung không phải iCal");
  } catch (error) {
    const message = (error as Error).message.slice(0, 300);
    await query("UPDATE ical_feeds SET last_error = $2 WHERE id = $1", [feedId, message]);
    return { ok: false as const, error: message };
  }

  const { ranges } = parseIcal(text, feed.timezone);
  const from = todayOps(feed.timezone);
  const to = addDays(from, WINDOW_DAYS);
  const channelNights = nightsOf(ranges, from, to);

  const result = await withTx(async (tx) => {
    const systemNights = await systemBusyNights(tx, feed.org_id, feed.unit_id, from, to);
    const missingInSystem = [...channelNights].filter((n) => !systemNights.all.has(n));
    const missingOnChannel = [...systemNights.settled].filter((n) => !channelNights.has(n));
    const found = [
      ...toRanges(missingInSystem).map((r) => ({ ...r, kind: "channel_busy_not_in_system" as const })),
      ...toRanges(missingOnChannel).map((r) => ({ ...r, kind: "system_busy_channel_free" as const })),
    ];
    const seenIds: string[] = [];
    for (const f of found) {
      const existing = await tx.query<{ id: string; status: string }>(
        "SELECT id, status FROM calendar_sync_findings WHERE feed_id = $1 AND kind = $2 AND start_date = $3 AND end_date = $4 AND status IN ('open','dismissed') ORDER BY status = 'open' DESC LIMIT 1",
        [feed.id, f.kind, f.start, f.end],
      );
      if (existing.rows[0]) {
        // Người đã chọn "bỏ qua" đúng khoảng này thì giữ nguyên, không mở lại.
        await tx.query("UPDATE calendar_sync_findings SET last_seen_at = now() WHERE id = $1", [existing.rows[0].id]);
        seenIds.push(existing.rows[0].id);
      } else {
        const ins = await tx.query<{ id: string }>(
          "INSERT INTO calendar_sync_findings (org_id, feed_id, unit_id, kind, start_date, end_date, detail) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [feed.org_id, feed.id, feed.unit_id, f.kind, f.start, f.end, JSON.stringify({ nights: [] })],
        );
        seenIds.push(ins.rows[0].id);
      }
    }
    // Phát hiện cũ không còn lệch ⇒ tự đóng, ghi rõ lý do
    const closed = await tx.query(
      `UPDATE calendar_sync_findings SET status = 'resolved', resolved_at = now(), resolution = 'Tự đóng: lần đồng bộ sau không còn lệch'
        WHERE feed_id = $1 AND status = 'open' AND NOT (id = ANY($2::uuid[])) AND end_date > $3`,
      [feed.id, seenIds, from],
    );
    await tx.query("UPDATE ical_feeds SET last_success_at = now(), last_error = NULL, last_event_count = $2 WHERE id = $1", [feed.id, ranges.length]);
    return { open: found.length, autoClosed: closed.rowCount ?? 0 };
  });
  return { ok: true as const, events: ranges.length, ...result };
}

/** Đêm hệ thống đang giữ trên tài nguyên của sản phẩm. `settled` bỏ các claim quá mới (kênh chưa kịp nhập). */
async function systemBusyNights(q: Queryable, orgId: string, unitId: string, from: string, to: string) {
  const { rows } = await q.query<{ start: string; end: string; created_at: Date }>(
    `SELECT lower(c.stay)::text AS start, upper(c.stay)::text AS "end", c.created_at
       FROM resource_claims c
      WHERE c.org_id = $1 AND c.active
        AND c.resource_id IN (SELECT resource_id FROM unit_resources WHERE unit_id = $2)
        AND c.stay && daterange($3::date, $4::date)`,
    [orgId, unitId, from, to],
  );
  const cutoff = now().getTime() - GRACE_HOURS * 3600_000;
  return {
    all: nightsOf(rows, from, to),
    settled: nightsOf(rows.filter((r) => new Date(r.created_at).getTime() < cutoff), from, to),
  };
}

export async function syncDueFeeds(fetcher: Fetcher = defaultFetcher) {
  const due = await query<{ id: string }>(
    "SELECT id FROM ical_feeds WHERE active AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(mins => poll_minutes)) ORDER BY last_attempt_at NULLS FIRST LIMIT 10",
  );
  let ok = 0;
  let failed = 0;
  for (const f of due) {
    const r = await syncFeed(f.id, fetcher);
    if (r.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed };
}

export async function syncFeedNow(actor: Actor, feedId: string) {
  if (!actor.permissions.has("connector.manage") && !actor.permissions.has("conflict.resolve")) assertCan(actor, "connector.manage");
  const owned = await queryOne<{ recent: boolean }>(
    "SELECT (last_attempt_at IS NOT NULL AND last_attempt_at > now() - interval '60 seconds') AS recent FROM ical_feeds WHERE id = $1 AND org_id = $2",
    [feedId, actor.orgId],
  );
  if (!owned) throw notFound("link iCal");
  if (owned.recent) throw conflict("too_soon", "Vừa đồng bộ link này dưới 1 phút trước — chờ một chút rồi thử lại.");
  return syncFeed(feedId);
}

export async function resolveFinding(actor: Actor, findingId: string, input: { status: "resolved" | "dismissed"; note: string }) {
  assertCan(actor, "conflict.resolve");
  if (!input.note?.trim()) throw invalid("Ghi cách đã xử lý.");
  const row = await queryOne<{ unit_id: string }>(
    "UPDATE calendar_sync_findings SET status = $2, resolved_at = now(), resolved_by = $3, resolution = $4 WHERE id = $1 AND org_id = $5 AND status = 'open' RETURNING unit_id",
    [findingId, input.status, actor.userId, input.note.trim(), actor.orgId],
  );
  if (!row) throw notFound("phát hiện đang mở");
  await writeAudit(null, auditActorOf(actor), "ical.finding_resolve", "unit", row.unit_id, { findingId, status: input.status });
  return { ok: true };
}

export async function listFeeds(actor: Actor) {
  assertCan(actor, "connector.view");
  return query(
    `SELECT f.id, f.url_hint, f.active, f.poll_minutes, f.last_attempt_at, f.last_success_at, f.last_error, f.last_event_count,
            l.id AS listing_id, l.channel, l.listing_name, u.code AS unit_code,
            (SELECT count(*)::int FROM calendar_sync_findings s WHERE s.feed_id = f.id AND s.status = 'open') AS open_findings
       FROM ical_feeds f JOIN channel_listings l ON l.id = f.listing_id JOIN units u ON u.id = l.unit_id
      WHERE f.org_id = $1 ORDER BY u.code, l.channel`,
    [actor.orgId],
  );
}

export async function listFindings(actor: Actor, status: "open" | "all" = "open") {
  assertCan(actor, "connector.view");
  return query(
    `SELECT s.id, s.kind, s.start_date, s.end_date, s.status, s.first_seen_at, s.last_seen_at, s.resolution,
            u.code AS unit_code, l.channel
       FROM calendar_sync_findings s JOIN ical_feeds f ON f.id = s.feed_id JOIN channel_listings l ON l.id = f.listing_id JOIN units u ON u.id = s.unit_id
      WHERE s.org_id = $1 AND ($2 = 'all' OR s.status = 'open')
      ORDER BY s.status = 'open' DESC, s.start_date LIMIT 300`,
    [actor.orgId, status],
  );
}

