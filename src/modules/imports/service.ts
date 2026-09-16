import crypto from "node:crypto";
import { query, queryOne, withTx } from "@/lib/db";
import { AppError, conflict, invalid, notFound } from "@/lib/errors";
import { localToUtc, todayOps } from "@/lib/time";
import { writeAudit, auditActorOf } from "@/modules/audit/audit";
import { type Actor, assertCan, systemActor } from "@/modules/auth/actor";
import { insertAllocation, recordBookingChange } from "@/modules/booking/service";
import { loadUnitLookup } from "./aliases";
import {
  type Disposition,
  type ImportStats,
  type ParsedFields,
  type ParsedImportRow,
  type RowIssue,
  type UnitLookup,
  ParseError,
  dispositionOf,
  inspectWorkbook,
  issue,
  parseBookingWorkbook,
  summarizeRows,
} from "./excel";

/**
 * Nhập Excel lịch đặt phòng: xem trước (lưu lô + từng dòng) → áp dụng (chỉ dòng hợp lệ, mỗi dòng một giao dịch).
 * Không bao giờ xoá dòng lặp, không cộng sheet nhà, không tự sửa ngày.
 */

export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

export interface UploadedFile {
  fileName: string;
  data: Buffer;
}

function assertXlsx(file: UploadedFile) {
  if (!/\.xlsx$/i.test(file.fileName)) throw invalid("Chỉ nhận file .xlsx.");
  if (file.data.length === 0) throw invalid("File rỗng.");
  if (file.data.length > MAX_IMPORT_BYTES) throw invalid(`File lớn hơn ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
  // .xlsx là file zip: 4 byte đầu "PK\x03\x04"
  if (file.data[0] !== 0x50 || file.data[1] !== 0x4b) throw invalid("File không phải định dạng .xlsx hợp lệ.");
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function withParseErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ParseError) throw new AppError(error.code, error.message, 422);
    if (error instanceof AppError) throw error;
    throw new AppError("unreadable_file", "Không đọc được file Excel (file hỏng hoặc không phải .xlsx).", 422);
  }
}

export async function inspectImportFile(actor: Actor, file: UploadedFile) {
  assertCan(actor, "import.preview");
  assertXlsx(file);
  const sheets = await withParseErrors(() => inspectWorkbook(file.data));
  return { fileName: file.fileName, sheets };
}

async function appliedBatchFor(orgId: string, fileSha: string) {
  return queryOne<{ id: string; applied_at: Date }>(
    "SELECT id, applied_at FROM import_batches WHERE org_id = $1 AND file_sha256 = $2 AND status = 'applied' LIMIT 1",
    [orgId, fileSha],
  );
}

/** Đánh dấu dòng đã có booking cùng kênh + mã trong tổ chức. Mã trùng ở kênh khác chỉ cảnh báo. */
export async function markAlreadyImported(orgId: string, rows: ParsedImportRow[]) {
  const refs = [...new Set(rows.map((r) => r.parsed.externalRef).filter((x): x is string => !!x))];
  if (!refs.length) return;
  const found = await query<{ source_channel: string; external_ref: string; id: string }>(
    "SELECT source_channel, external_ref, id FROM bookings WHERE org_id = $1 AND external_ref = ANY($2::text[])",
    [orgId, refs],
  );
  const byRef = new Map<string, { channel: string; id: string }[]>();
  for (const f of found) byRef.set(f.external_ref, [...(byRef.get(f.external_ref) ?? []), { channel: f.source_channel, id: f.id }]);
  for (const r of rows) {
    const ref = r.parsed.externalRef;
    if (!ref || !byRef.has(ref)) continue;
    const hits = byRef.get(ref)!;
    const same = r.parsed.channel ? hits.find((h) => h.channel === r.parsed.channel) : undefined;
    if (same && (r.disposition === "ready" || r.disposition === "needs_review")) {
      r.disposition = "already_imported";
    } else if (!same) {
      r.issues.push(issue("ref_exists_other_channel", `Mã đã có trong hệ thống ở kênh ${hits.map((h) => h.channel).join(", ")}.`));
      r.disposition = dispositionOf(r.issues, r.disposition);
    }
  }
}

export interface PreviewResult {
  batchId: string;
  fileSha256: string;
  sourceSheet: string;
  stats: ImportStats & { sheets: unknown };
}

/** Phân tích file và lưu lô xem trước cho tổ chức của actor. Không tạo booking. */
export async function previewImport(actor: Actor, file: UploadedFile, opts: { sourceSheet?: string; lookup?: UnitLookup } = {}): Promise<PreviewResult> {
  assertCan(actor, "import.preview");
  assertXlsx(file);
  const fileSha = sha256(file.data);
  const applied = await appliedBatchFor(actor.orgId, fileSha);
  if (applied) throw conflict("file_already_applied", "File này (cùng nội dung) đã được áp dụng trước đó.", { batchId: applied.id });

  const lookup = opts.lookup ?? (await loadUnitLookup(actor.orgId));
  const result = await withParseErrors(() => parseBookingWorkbook(file.data, { sourceSheet: opts.sourceSheet, lookup }));
  await markAlreadyImported(actor.orgId, result.rows);
  const stats = { ...summarizeRows(result.rows), sheets: result.sheets };

  const batchId = await withTx(async (tx) => {
    const batch = await tx.query<{ id: string }>(
      `INSERT INTO import_batches (org_id, file_name, file_sha256, status, stats, options, created_by)
       VALUES ($1,$2,$3,'previewed',$4,$5,$6) RETURNING id`,
      [actor.orgId, file.fileName.slice(0, 255), fileSha, JSON.stringify(stats), JSON.stringify({ sourceSheet: result.sourceSheet }), actor.userId],
    );
    const id = batch.rows[0].id;
    const CHUNK = 400;
    for (let i = 0; i < result.rows.length; i += CHUNK) {
      const chunk = result.rows.slice(i, i + CHUNK).map((r) => ({
        sheet: r.sheet,
        row_number: r.rowNumber,
        raw: r.raw,
        parsed: r.parsed,
        issues: r.issues,
        disposition: r.disposition,
        source_key: r.sourceKey,
      }));
      await tx.query(
        `INSERT INTO import_rows (org_id, batch_id, sheet, row_number, raw, parsed, issues, disposition, source_key)
         SELECT $1, $2, x.sheet, x.row_number, x.raw, x.parsed, x.issues, x.disposition, x.source_key
           FROM jsonb_to_recordset($3::jsonb) AS x(sheet text, row_number int, raw jsonb, parsed jsonb, issues jsonb, disposition text, source_key text)`,
        [actor.orgId, id, JSON.stringify(chunk)],
      );
    }
    await writeAudit(tx, auditActorOf(actor), "import.preview", "import_batch", id, {
      fileName: file.fileName,
      fileSha256: fileSha,
      sourceSheet: result.sourceSheet,
      byDisposition: stats.byDisposition,
    });
    return id;
  });
  return { batchId, fileSha256: fileSha, sourceSheet: result.sourceSheet, stats };
}

// ───────────────────────── Áp dụng ─────────────────────────

export interface ApplyOptions {
  /** Bỏ qua (skipped) các dòng có ngày trả phòng trước mốc này. Không truyền ⇒ nhập cả lịch sử. */
  skipCheckOutBefore?: string | null;
}

export interface ApplyResult {
  batchId: string;
  applied: number;
  alreadyImported: number;
  errors: number;
  skipped: number;
  stats: ImportStats;
}

interface ReadyRow {
  id: string;
  sheet: string;
  row_number: number;
  parsed: ParsedFields;
  issues: RowIssue[];
}

type RowOutcome = { disposition: Extract<Disposition, "applied" | "already_imported">; bookingId: string | null } | { disposition: "error"; error: RowIssue };

/**
 * Nhập một dòng thành booking trong giao dịch riêng.
 * Không đi qua createBooking vì booking lịch sử cần stay_status 'unknown' và ngày nhận booking theo Excel
 * (đã đề xuất bổ sung tuỳ chọn cho lõi). Tồn phòng vẫn giữ bằng insertAllocation (khoá + kiểm + EXCLUDE);
 * lịch sử ghi bằng recordBookingChange; khoá mã nguồn dùng cùng khoá tư vấn với service lõi.
 */
async function applyRow(importer: Actor, batchId: string, row: ReadyRow, today: string): Promise<RowOutcome> {
  const p = row.parsed;
  if (!p.externalRef || !p.channel || !p.unit?.unitId || !p.checkIn || !p.checkOut || !p.guestName) {
    return { disposition: "error", error: issue("apply_error", "Dòng thiếu dữ liệu bắt buộc (mã, kênh, phòng, ngày, tên khách) — phân tích lại file.") };
  }
  const { externalRef: ref, channel, checkIn, checkOut, guestName } = p;
  const unitId = p.unit.unitId;
  try {
    return await withTx(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7332))", [`${importer.orgId}|${channel}||${ref}`]);
      const existing = await tx.query<{ id: string }>(
        "SELECT id FROM bookings WHERE org_id = $1 AND source_channel = $2 AND source_account = '' AND external_ref = $3",
        [importer.orgId, channel, ref],
      );
      if (existing.rows[0]) return { disposition: "already_imported" as const, bookingId: existing.rows[0].id };

      const guest = await tx.query<{ id: string }>("INSERT INTO guests (org_id, full_name, phone) VALUES ($1,$2,$3) RETURNING id", [
        importer.orgId,
        guestName.slice(0, 200),
        p.guestPhone?.slice(0, 50) ?? null,
      ]);
      // Khách đã/đang ở theo lịch thì không biết thực tế đã nhận/trả phòng chưa ⇒ 'unknown'.
      const stayStatus = checkIn <= today ? "unknown" : "expected";
      // Ngày nhận booking mơ hồ (ô Date ngày ≤ 12) hoặc sau ngày nhận phòng thì để trống — không ghi một ngày có thể sai.
      const bookedAt = p.bookedDate && !p.bookedDateAmbiguous && p.bookedDate <= checkIn ? localToUtc(p.bookedDate, "00:00", importer.timezone) : null;
      const channelNote = [p.note && !p.paymentNote ? `Ghi chú Excel: ${p.note}` : null, p.paymentNote ? `Khoản thu ghi trong Excel (chưa đối soát): ${p.paymentNote}` : null]
        .filter(Boolean)
        .join("\n");
      const opsNote = [p.checkinNote ? `Giờ check-in (Excel): ${p.checkinNote}` : null, p.statusText ? `Tình trạng (Excel): ${p.statusText}` : null, `Nhập từ sheet ${row.sheet} dòng ${row.row_number}`]
        .filter(Boolean)
        .join("\n");
      const created = await tx.query<{ id: string; org_id: string; version: number }>(
        `INSERT INTO bookings (org_id, source_channel, source_account, external_ref, guest_id, booking_status, stay_status, payment_status,
                               check_in_date, check_out_date, total_guests, currency, booking_created_at, channel_note, ops_note, created_by)
         VALUES ($1,$2,'',$3,$4,'confirmed',$5,'unknown',$6,$7,$8,'EUR',$9,$10,$11,$12)
         RETURNING id, org_id, version`,
        [importer.orgId, channel, ref, guest.rows[0].id, stayStatus, checkIn, checkOut, p.totalGuests, bookedAt, channelNote || null, opsNote.slice(0, 2000), importer.userId],
      );
      const booking = created.rows[0];
      await insertAllocation(tx, importer.orgId, booking.id, { unitId, startDate: checkIn, endDate: checkOut, guests: p.totalGuests }, { onConflict: "throw" });
      await recordBookingChange(tx, booking, "imported", null, {
        actorType: "import",
        actorId: importer.userId,
        source: "excel",
        sourceRef: `${batchId}:${row.sheet}:${row.row_number}`,
      });
      await writeAudit(tx, auditActorOf(importer), "booking.import", "booking", booking.id, { batchId, sheet: row.sheet, rowNumber: row.row_number, sourceChannel: channel, externalRef: ref });
      return { disposition: "applied" as const, bookingId: booking.id };
    });
  } catch (error) {
    if (error instanceof AppError) {
      return { disposition: "error", error: issue("apply_error", error.message, { code: error.code, details: error.details }) };
    }
    console.error("[import] lỗi không mong đợi ở dòng", row.sheet, row.row_number, error);
    return { disposition: "error", error: issue("apply_error", "Lỗi hệ thống khi ghi dòng này.", { code: "internal_error" }) };
  }
}

/**
 * Áp dụng lô: chỉ dòng 'ready'. File (sha256) đã áp dụng ở lô khác ⇒ từ chối.
 * Lô bị ngắt giữa chừng có thể chạy lại: dòng đã xử lý không còn 'ready' nên không tạo trùng.
 */
export async function applyImport(actor: Actor, batchId: string, opts: ApplyOptions = {}): Promise<ApplyResult> {
  assertCan(actor, "import.apply");
  if (opts.skipCheckOutBefore && !/^\d{4}-\d{2}-\d{2}$/.test(opts.skipCheckOutBefore)) throw invalid("Mốc ngày không hợp lệ (YYYY-MM-DD).");

  await withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string; file_sha256: string }>(
      "SELECT id, status, file_sha256 FROM import_batches WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [batchId, actor.orgId],
    );
    const batch = rows[0];
    if (!batch) throw notFound("lô nhập");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340))", [`${actor.orgId}|${batch.file_sha256}`]);
    if (batch.status === "discarded") throw conflict("batch_discarded", "Lô này đã bị huỷ.");
    const other = await tx.query<{ id: string }>(
      "SELECT id FROM import_batches WHERE org_id = $1 AND file_sha256 = $2 AND status = 'applied' AND id <> $3 LIMIT 1",
      [actor.orgId, batch.file_sha256, batchId],
    );
    if (other.rows[0]) throw conflict("file_already_applied", "File này (cùng nội dung) đã được áp dụng ở lô khác.", { batchId: other.rows[0].id });
    if (batch.status === "applied") {
      const left = await tx.query("SELECT 1 FROM import_rows WHERE batch_id = $1 AND disposition = 'ready' LIMIT 1", [batchId]);
      if (!left.rows.length) throw conflict("batch_already_applied", "Lô này đã được áp dụng.");
    } else {
      await tx.query("UPDATE import_batches SET status = 'applied', applied_by = $2, applied_at = now() WHERE id = $1", [batchId, actor.userId]);
    }
    await writeAudit(tx, auditActorOf(actor), "import.apply_started", "import_batch", batchId, { skipCheckOutBefore: opts.skipCheckOutBefore ?? null });
  });

  // Tác nhân nhập: chỉ quyền cần để ghi booking; vẫn gắn người bấm áp dụng để truy vết.
  const importer: Actor = { ...systemActor(actor.orgId, "import", ["booking.create", "revenue.view"], actor.timezone), userId: actor.userId, ip: actor.ip };
  const today = todayOps(actor.timezone);
  const readyRows = await query<ReadyRow>(
    "SELECT id, sheet, row_number, parsed, issues FROM import_rows WHERE batch_id = $1 AND org_id = $2 AND disposition = 'ready' ORDER BY sheet, row_number",
    [batchId, actor.orgId],
  );

  const result = { applied: 0, alreadyImported: 0, errors: 0, skipped: 0 };
  for (const row of readyRows) {
    if (opts.skipCheckOutBefore && row.parsed.checkOut && row.parsed.checkOut < opts.skipCheckOutBefore) {
      const issues = [...row.issues, issue("past_stay_skipped", `Ngày trả phòng trước ${opts.skipCheckOutBefore} — không nhập ở lần áp dụng này.`)];
      await query("UPDATE import_rows SET disposition = 'skipped', issues = $2 WHERE id = $1 AND disposition = 'ready'", [row.id, JSON.stringify(issues)]);
      result.skipped += 1;
      continue;
    }
    const outcome = await applyRow(importer, batchId, row, today);
    if (outcome.disposition === "error") {
      await query("UPDATE import_rows SET disposition = 'error', issues = $2 WHERE id = $1", [row.id, JSON.stringify([...row.issues, outcome.error])]);
      result.errors += 1;
    } else {
      await query("UPDATE import_rows SET disposition = $2, booking_id = $3 WHERE id = $1", [row.id, outcome.disposition, outcome.bookingId]);
      if (outcome.disposition === "applied") result.applied += 1;
      else result.alreadyImported += 1;
    }
  }

  const stats = await recomputeStats(actor.orgId, batchId, { ...result, finishedAt: new Date().toISOString(), skipCheckOutBefore: opts.skipCheckOutBefore ?? null });
  await writeAudit(null, auditActorOf(actor), "import.apply_finished", "import_batch", batchId, result);
  return { batchId, ...result, stats };
}

async function recomputeStats(orgId: string, batchId: string, applyInfo: Record<string, unknown>): Promise<ImportStats> {
  const rows = await query<{ sheet: string; disposition: Disposition; issues: RowIssue[] }>(
    "SELECT sheet, disposition, issues FROM import_rows WHERE batch_id = $1 AND org_id = $2",
    [batchId, orgId],
  );
  const summary = summarizeRows(rows);
  const current = await queryOne<{ stats: Record<string, unknown> }>("SELECT stats FROM import_batches WHERE id = $1 AND org_id = $2", [batchId, orgId]);
  const runs = Array.isArray(current?.stats?.applyRuns) ? (current!.stats.applyRuns as unknown[]) : [];
  const stats = { ...(current?.stats ?? {}), ...summary, apply: applyInfo, applyRuns: [...runs, applyInfo] };
  await query("UPDATE import_batches SET stats = $2 WHERE id = $1 AND org_id = $3", [batchId, JSON.stringify(stats), orgId]);
  return summary;
}

/** Huỷ một lô chưa áp dụng (không xoá dòng — giữ dấu vết). */
export async function discardImport(actor: Actor, batchId: string) {
  assertCan(actor, "import.preview");
  const row = await queryOne<{ status: string }>("SELECT status FROM import_batches WHERE id = $1 AND org_id = $2", [batchId, actor.orgId]);
  if (!row) throw notFound("lô nhập");
  if (row.status !== "previewed") throw conflict("batch_not_previewed", "Chỉ huỷ được lô chưa áp dụng.");
  await query("UPDATE import_batches SET status = 'discarded' WHERE id = $1 AND org_id = $2 AND status = 'previewed'", [batchId, actor.orgId]);
  await writeAudit(null, auditActorOf(actor), "import.discard", "import_batch", batchId, {});
  return { id: batchId, status: "discarded" };
}

