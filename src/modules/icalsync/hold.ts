import type { Queryable } from "@/lib/db";
import { CHANNEL_LABELS } from "@/modules/booking/types";
import { claimForBlock, lockAndCheck, lockResources, resourceIdsForUnit } from "@/modules/inventory/inventory";
import { type BusyRange, nightsOf, toRanges } from "./parse";

/**
 * Giữ chỗ theo lịch kênh (hold_mode = 'block').
 *
 * Mỗi sự kiện BẬN đọc được từ link iCal được giữ bằng `inventory_blocks` của đúng phòng thuộc link,
 * đánh dấu `source='ical'`, `ical_feed_id`, `source_ref` = mã sự kiện (UID) của kênh.
 *
 * Quy tắc bất biến:
 *   - Không tạo/sửa/huỷ booking của khách. Chỉ chặn tồn.
 *   - Không bao giờ chặn đè lên booking hay chặn tay: đêm nào đang bị chiếm thì CẮT ra, chỉ giữ phần còn trống
 *     (một sự kiện có thể thành nhiều đoạn chặn). Phần bị cắt đếm vào `skipped`.
 *   - Chặn do người tạo tay (`source='manual'`) không bao giờ bị gỡ ở đây.
 *   - Sự kiện còn trong feed thì chặn của nó KHÔNG bao giờ bị gỡ mà không có cái thay thế:
 *     chặn cũ chỉ bị gỡ khi nó nằm ngoài khoảng hiện tại của sự kiện (sự kiện co lại/đổi ngày) hoặc sự kiện biến mất.
 *   - So khớp chặn cũ với sự kiện theo NGÀY GỐC của sự kiện (chưa cắt về cửa sổ đồng bộ), nên chặn của một
 *     lưu trú đang diễn ra không bị gỡ–tạo lại mỗi ngày khi "hôm nay" trượt.
 */

export interface HoldFeed {
  id: string;
  org_id: string;
  unit_id: string;
  channel: string;
}

export interface HoldResult {
  /** Đoạn chặn mới tạo trong lần đồng bộ này. */
  created: number;
  /** Chặn cũ đã gỡ vì sự kiện biến mất hoặc khoảng của nó đã đổi. */
  released: number;
  /** Số sự kiện của kênh không giữ được trọn vẹn vì đã có booking hoặc chặn tay chiếm. */
  skipped: number;
}

interface Range {
  start: string;
  end: string;
}

/** Gom khoảng bận theo mã sự kiện. Giữ NGÀY GỐC — cắt về cửa sổ đồng bộ chỉ làm khi tính đêm cần giữ. */
function rangesByRef(ranges: BusyRange[]): Map<string, Range[]> {
  const byRef = new Map<string, Range[]>();
  const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  for (const r of sorted) {
    // Kênh có thể không gửi UID: khi đó dùng chính khoảng gốc làm mã, vẫn nhận lại được ở lần sau.
    const ref = r.uid?.trim() || `${r.start}..${r.end}`;
    const list = byRef.get(ref);
    if (!list) byRef.set(ref, [{ start: r.start, end: r.end }]);
    else if (!list.some((x) => x.start === r.start && x.end === r.end)) list.push({ start: r.start, end: r.end });
  }
  return byRef;
}

async function releaseBlock(tx: Queryable, blockId: string) {
  await tx.query("UPDATE inventory_blocks SET active = false, released_at = now() WHERE id = $1 AND active", [blockId]);
  await tx.query("UPDATE resource_claims SET active = false WHERE block_id = $1 AND active", [blockId]);
}

/** Gỡ mọi chặn do một link sinh ra (tắt giữ chỗ, xoá link). Chặn tay không bị đụng. */
export async function releaseHoldsOfFeed(tx: Queryable, feedId: string): Promise<number> {
  const { rows } = await tx.query<{ id: string }>("SELECT id FROM inventory_blocks WHERE ical_feed_id = $1 AND source = 'ical' AND active", [feedId]);
  for (const row of rows) await releaseBlock(tx, row.id);
  return rows.length;
}

/** Đêm đang bị chiếm trên tài nguyên của phòng, tách "của chính link này" và "của người khác" (booking, chặn tay, link khác). */
async function occupiedNights(tx: Queryable, feed: HoldFeed, from: string, to: string) {
  const { rows } = await tx.query<{ start: string; end: string; ours: boolean }>(
    `SELECT lower(c.stay)::text AS start, upper(c.stay)::text AS "end", coalesce(b.ical_feed_id = $5, false) AS ours
       FROM resource_claims c
       LEFT JOIN inventory_blocks b ON b.id = c.block_id AND b.source = 'ical'
      WHERE c.org_id = $1 AND c.active
        AND c.resource_id IN (SELECT resource_id FROM unit_resources WHERE unit_id = $2)
        AND c.stay && daterange($3::date, $4::date)`,
    [feed.org_id, feed.unit_id, from, to, feed.id],
  );
  return {
    ours: nightsOf(rows.filter((r) => r.ours), from, to),
    others: nightsOf(rows.filter((r) => !r.ours), from, to),
  };
}

/**
 * Đối chiếu chặn đang giữ với lịch kênh vừa đọc.
 * Chạy trong giao dịch của lần đồng bộ, khoá tài nguyên của phòng ngay từ đầu để cả lần đối chiếu
 * nhìn một ảnh chụp ổn định; theo lối "kiểm trước rồi ghi", không dựa vào lỗi ràng buộc để phát hiện trùng.
 */
export async function applyHolds(tx: Queryable, feed: HoldFeed, ranges: BusyRange[], from: string, to: string): Promise<HoldResult> {
  const byRef = rangesByRef(ranges);
  const resourceIds = await resourceIdsForUnit(tx, feed.org_id, feed.unit_id);
  // Phòng chưa khai báo tài nguyên thì không giữ tồn được. Không đụng gì cả (kể cả gỡ) để không mất chỗ đang giữ.
  if (resourceIds.length === 0) return { created: 0, released: 0, skipped: byRef.size };
  await lockResources(tx, resourceIds);

  // 1. Gỡ chặn không còn khớp sự kiện nào: sự kiện biến mất, hoặc chặn nằm ngoài khoảng hiện tại của sự kiện.
  const existing = await tx.query<{ id: string; source_ref: string | null; start_date: string; end_date: string }>(
    "SELECT id, source_ref, start_date, end_date FROM inventory_blocks WHERE ical_feed_id = $1 AND source = 'ical' AND active ORDER BY start_date",
    [feed.id],
  );
  let released = 0;
  for (const block of existing.rows) {
    const refRanges = byRef.get(block.source_ref ?? "");
    const stillInsideEvent = refRanges?.some((r) => block.start_date >= r.start && block.end_date <= r.end) ?? false;
    if (stillInsideEvent) continue; // sự kiện còn đó và chặn vẫn nằm trong khoảng của nó ⇒ giữ nguyên, không tạo lại
    await releaseBlock(tx, block.id);
    released += 1;
  }

  // 2. Chặn phần còn trống của từng sự kiện (sau khi đã gỡ ở bước 1).
  const busy = await occupiedNights(tx, feed, from, to);
  const reason = `Giữ chỗ theo lịch ${CHANNEL_LABELS[feed.channel] ?? feed.channel}`;
  let created = 0;
  let skipped = 0;
  for (const [ref, refRanges] of byRef) {
    const wanted = nightsOf(refRanges, from, to); // cắt về cửa sổ đồng bộ: không chặn ngược về quá khứ
    if (wanted.size === 0) continue;
    let cut = false;
    const free: string[] = [];
    for (const night of wanted) {
      if (busy.others.has(night)) cut = true; // đã có booking/chặn tay giữ đêm này — không chặn đè
      else if (!busy.ours.has(night)) free.push(night);
    }
    for (const segment of toRanges(free)) {
      const span = { unit_id: feed.unit_id, start_date: segment.start, end_date: segment.end };
      const { conflicts } = await lockAndCheck(tx, feed.org_id, span);
      if (conflicts.length) {
        // Chốt cuối: lẽ ra không xảy ra vì đã trừ đêm bị chiếm ở trên. Bỏ qua đoạn này thay vì ném lỗi làm hỏng cả lần đồng bộ.
        cut = true;
        continue;
      }
      const { rows } = await tx.query<{ id: string; unit_id: string; start_date: string; end_date: string }>(
        `INSERT INTO inventory_blocks (org_id, unit_id, start_date, end_date, reason, source, source_ref, ical_feed_id)
         VALUES ($1,$2,$3,$4,$5,'ical',$6,$7) RETURNING id, unit_id, start_date, end_date`,
        [feed.org_id, feed.unit_id, segment.start, segment.end, reason, ref, feed.id],
      );
      await claimForBlock(tx, feed.org_id, rows[0]);
      for (const night of nightsOf([segment], from, to)) busy.ours.add(night);
      created += 1;
    }
    if (cut) skipped += 1;
  }
  return { created, released, skipped };
}
