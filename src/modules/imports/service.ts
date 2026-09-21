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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Lượt áp dụng bị ngắt (tiến trình chết) để lại cờ; quá hạn này coi như đã dừng. */
const APPLY_STALE_MS = 30 * 60_000;

function assertBatchId(batchId: string) {
  if (!UUID_RE.test(batchId)) throw notFound("lô nhập");
}

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

/** Nhãn tài khoản nguồn để đưa vào thông điệp — lô cũ không ghi tài khoản thì nói rõ là chưa ghi. */
const accountText = (account: string) => account || "chưa ghi tài khoản";

/**
 * `source_account = ''` nghĩa là CHƯA BIẾT tài khoản, không phải "tài khoản tên rỗng": mọi booking nhập
 * trước khi có ô chọn tài khoản đều mang giá trị này. Nên một bên rỗng thì coi như CÙNG đơn — nếu không,
 * nhập lại bản xuất tháng sau (lần này có chọn tài khoản) sẽ đẻ ra booking thứ hai cho cùng một đơn thật.
 */
const sameSourceAccount = (a: string, b: string) => a === b || a === "" || b === "";

/**
 * Đánh dấu dòng đã có booking cùng kênh + cùng tài khoản + mã trong tổ chức (xem `sameSourceAccount`).
 * Chỉ khi CẢ HAI bên đều ghi rõ tài khoản và khác nhau mới là hai đơn khác nhau ⇒ cảnh báo, vẫn nhập được.
 * Mã trùng ở kênh khác cũng chỉ cảnh báo.
 */
export async function markAlreadyImported(orgId: string, rows: ParsedImportRow[], sourceAccount = "") {
  const refs = [...new Set(rows.map((r) => r.parsed.externalRef).filter((x): x is string => !!x))];
  if (!refs.length) return;
  const found = await query<{ source_channel: string; source_account: string; external_ref: string; id: string }>(
    "SELECT source_channel, source_account, external_ref, id FROM bookings WHERE org_id = $1 AND external_ref = ANY($2::text[])",
    [orgId, refs],
  );
  const byRef = new Map<string, { channel: string; account: string; id: string }[]>();
  for (const f of found) byRef.set(f.external_ref, [...(byRef.get(f.external_ref) ?? []), { channel: f.source_channel, account: f.source_account, id: f.id }]);
  for (const r of rows) {
    const ref = r.parsed.externalRef;
    if (!ref || !byRef.has(ref)) continue;
    const hits = byRef.get(ref)!;
    const sameChannel = r.parsed.channel ? hits.filter((h) => h.channel === r.parsed.channel) : [];
    // Khớp đúng tài khoản trước; không có thì mới nhận bản ghi "chưa biết tài khoản" (dữ liệu nhập đời trước).
    const same = sameChannel.find((h) => h.account === sourceAccount) ?? sameChannel.find((h) => sameSourceAccount(h.account, sourceAccount));
    if (same && (r.disposition === "ready" || r.disposition === "needs_review")) {
      r.disposition = "already_imported";
    } else if (!same && sameChannel.length) {
      r.issues.push(
        issue(
          "ref_exists_other_account",
          `Mã đã có ở kênh này nhưng thuộc tài khoản ${sameChannel.map((h) => accountText(h.account)).join(", ")} — lô này nhập cho tài khoản ${accountText(sourceAccount)}.`,
        ),
      );
      r.disposition = dispositionOf(r.issues, r.disposition);
    } else if (!same) {
      r.issues.push(issue("ref_exists_other_channel", `Mã đã có trong hệ thống ở kênh ${hits.map((h) => h.channel).join(", ")}.`));
      r.disposition = dispositionOf(r.issues, r.disposition);
    }
  }
}

// ───────────────────────── Tài khoản nguồn của lô ─────────────────────────

export interface SourceAccountChoice {
  /** Ghi thẳng vào `bookings.source_account`. Rỗng = lô không khai tài khoản (tương thích dữ liệu cũ). */
  sourceAccount: string;
  connectorId: string | null;
}

/** Tổ chức có từ hai tài khoản trở lên trên CÙNG một kênh ⇒ lô nhập buộc phải nói rõ của tài khoản nào. */
export async function importNeedsAccountChoice(orgId: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM (SELECT 1 FROM connector_accounts WHERE org_id = $1 GROUP BY channel HAVING count(*) > 1) x",
    [orgId],
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Tài khoản nguồn của lô: `connectorId`, hoặc nhãn — nhưng nhãn PHẢI khớp một `connector_accounts.label` có thật
 * của tổ chức (cùng cách với `loadConnector` trong `ota-catalog.ts`). Nhận nhãn gõ tự do là mở đường cho
 * "BDC  Nha X" (hai dấu cách) thành một namespace khoá nguồn riêng — đúng cái đường sinh booking trùng.
 * Không khai gì mà tổ chức đang có nhiều tài khoản cùng kênh ⇒ dừng, không đoán.
 */
async function resolveSourceAccount(orgId: string, opts: { connectorId?: string | null; sourceAccount?: string | null }): Promise<SourceAccountChoice> {
  const connectorId = opts.connectorId?.trim() || null;
  if (connectorId) {
    if (!UUID_RE.test(connectorId)) throw notFound("tài khoản kênh");
    const row = await queryOne<{ id: string; label: string }>("SELECT id, label FROM connector_accounts WHERE id = $1 AND org_id = $2", [connectorId, orgId]);
    if (!row) throw notFound("tài khoản kênh");
    return { sourceAccount: row.label, connectorId: row.id };
  }
  const label = (opts.sourceAccount ?? "").trim();
  if (!label) {
    if (await importNeedsAccountChoice(orgId)) {
      throw new AppError(
        "source_account_required",
        "Tổ chức có nhiều tài khoản trên cùng một kênh — chọn tài khoản nguồn cho lô nhập này (hai tài khoản có thể trùng mã đặt phòng).",
        422,
      );
    }
    return { sourceAccount: "", connectorId: null };
  }
  // Cùng nhãn ở hai kênh thì giá trị ghi vào `source_account` vẫn như nhau; `connectorId` chỉ để truy vết.
  const row = await queryOne<{ id: string; label: string }>("SELECT id, label FROM connector_accounts WHERE org_id = $1 AND label = $2 ORDER BY channel LIMIT 1", [orgId, label]);
  if (!row) throw notFound(`tài khoản kênh "${label}" — tạo tài khoản trong màn hình Kết nối rồi nhập lại`);
  return { sourceAccount: row.label, connectorId: row.id };
}

export interface PreviewResult {
  batchId: string;
  fileSha256: string;
  sourceSheet: string;
  sourceAccount: string;
  stats: ImportStats & { sheets: unknown };
}

export interface PreviewOptions {
  sourceSheet?: string;
  /** Tài khoản OTA của lô — lấy nhãn từ `connector_accounts`. */
  connectorId?: string | null;
  /** Nhãn tài khoản gõ tay khi chưa có connector tương ứng. */
  sourceAccount?: string | null;
  lookup?: UnitLookup;
}

/** Phân tích file và lưu lô xem trước cho tổ chức của actor. Không tạo booking. */
export async function previewImport(actor: Actor, file: UploadedFile, opts: PreviewOptions = {}): Promise<PreviewResult> {
  assertCan(actor, "import.preview");
  assertXlsx(file);
  const account = await resolveSourceAccount(actor.orgId, opts);
  const fileSha = sha256(file.data);
  const applied = await appliedBatchFor(actor.orgId, fileSha);
  if (applied) throw conflict("file_already_applied", "File này (cùng nội dung) đã được áp dụng trước đó.", { batchId: applied.id });

  const lookup = opts.lookup ?? (await loadUnitLookup(actor.orgId));
  const result = await withParseErrors(() => parseBookingWorkbook(file.data, { sourceSheet: opts.sourceSheet, lookup }));
  await markAlreadyImported(actor.orgId, result.rows, account.sourceAccount);
  const stats = { ...summarizeRows(result.rows), sheets: result.sheets };

  const batchId = await withTx(async (tx) => {
    const batch = await tx.query<{ id: string }>(
      `INSERT INTO import_batches (org_id, file_name, file_sha256, status, stats, options, created_by)
       VALUES ($1,$2,$3,'previewed',$4,$5,$6) RETURNING id`,
      [
        actor.orgId,
        file.fileName.slice(0, 255),
        fileSha,
        JSON.stringify(stats),
        JSON.stringify({ sourceSheet: result.sourceSheet, sourceAccount: account.sourceAccount, connectorId: account.connectorId }),
        actor.userId,
      ],
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
      sourceAccount: account.sourceAccount,
      connectorId: account.connectorId,
      byDisposition: stats.byDisposition,
    });
    return id;
  });
  return { batchId, fileSha256: fileSha, sourceSheet: result.sourceSheet, sourceAccount: account.sourceAccount, stats };
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

type RowOutcome =
  | { disposition: Extract<Disposition, "applied" | "already_imported">; bookingId: string | null }
  | { disposition: "error"; error: RowIssue }
  /** Dòng không còn 'ready' (lượt khác đã xử lý) — bỏ qua, không đếm */
  | { disposition: "not_ready" };

/**
 * Nhập một dòng thành booking trong giao dịch riêng.
 * Không đi qua createBooking vì booking lịch sử cần stay_status 'unknown' và ngày nhận booking theo Excel
 * (đã đề xuất bổ sung tuỳ chọn cho lõi). Tồn phòng vẫn giữ bằng insertAllocation (khoá + kiểm + EXCLUDE);
 * lịch sử ghi bằng recordBookingChange; khoá mã nguồn dùng cùng khoá tư vấn với service lõi.
 */
async function applyRow(importer: Actor, batchId: string, row: ReadyRow, today: string, isDemo: boolean, sourceAccount: string): Promise<RowOutcome> {
  const p = row.parsed;
  if (!p.externalRef || !p.channel || !p.unit?.unitId || !p.checkIn || !p.checkOut || !p.guestName) {
    return { disposition: "error", error: issue("apply_error", "Dòng thiếu dữ liệu bắt buộc (mã, kênh, phòng, ngày, tên khách) — phân tích lại file.") };
  }
  const { externalRef: ref, channel, checkIn, checkOut, guestName } = p;
  const unitId = p.unit.unitId;
  try {
    return await withTx(async (tx) => {
      // Nhận dòng: chỉ xử lý nếu vẫn 'ready' (khoá dòng tới hết giao dịch) — hai lượt áp dụng không ghi đè kết quả của nhau.
      const claim = await tx.query("SELECT 1 FROM import_rows WHERE id = $1 AND disposition = 'ready' FOR UPDATE", [row.id]);
      if (!claim.rows.length) return { disposition: "not_ready" as const };
      // Khoá "chưa biết tài khoản" (org|kênh||mã) luôn lấy TRƯỚC: một lô ghi '' và một lô có nhãn cùng mã vẫn là
      // cùng một đơn (xem `sameSourceAccount`) nên phải xếp hàng với nhau; khoá theo đúng tài khoản lấy sau để giữ
      // cùng khoá tư vấn với service lõi (`booking/service.ts`). Thứ tự cố định ⇒ hai lô không kẹt chéo.
      const lock = "SELECT pg_advisory_xact_lock(hashtextextended($1, 7332))";
      await tx.query(lock, [`${importer.orgId}|${channel}||${ref}`]);
      if (sourceAccount) await tx.query(lock, [`${importer.orgId}|${channel}|${sourceAccount}|${ref}`]);
      // Đã có booking cùng kênh + mã ở cùng tài khoản (hoặc một bên chưa biết tài khoản) ⇒ không tạo thêm.
      // Chỉ khi cả hai bên ghi rõ tài khoản và khác nhau mới là đơn khác. Bản ghi đúng tài khoản được ưu tiên.
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM bookings
          WHERE org_id = $1 AND source_channel = $2 AND external_ref = $4
            AND (source_account = $3 OR source_account = '' OR $3 = '')
          ORDER BY (source_account = $3) DESC, created_at LIMIT 1`,
        [importer.orgId, channel, sourceAccount, ref],
      );
      if (existing.rows[0]) {
        await tx.query("UPDATE import_rows SET disposition = 'already_imported', booking_id = $2 WHERE id = $1", [row.id, existing.rows[0].id]);
        return { disposition: "already_imported" as const, bookingId: existing.rows[0].id };
      }

      const guest = await tx.query<{ id: string }>("INSERT INTO guests (org_id, full_name, phone, is_demo) VALUES ($1,$2,$3,$4) RETURNING id", [
        importer.orgId,
        guestName.slice(0, 200),
        p.guestPhone?.slice(0, 50) ?? null,
        isDemo,
      ]);
      // Khách đã/đang ở theo lịch thì không biết thực tế đã nhận/trả phòng chưa ⇒ 'unknown'.
      const stayStatus = checkIn <= today ? "unknown" : "expected";
      // Ngày nhận booking mơ hồ (ô Date ngày ≤ 12) hoặc sau ngày nhận phòng thì để trống — không ghi một ngày có thể sai.
      const bookedAt = p.bookedDate && !p.bookedDateAmbiguous && p.bookedDate <= checkIn ? localToUtc(p.bookedDate, "00:00", importer.timezone) : null;
      // channel_note hiện cho mọi người có booking.view ⇒ không chép khoản thu/số tiền; nguyên văn còn ở dòng nhập (quyền import).
      const channelNote = p.paymentNote ? "Ghi chú Excel có khoản thu chưa đối soát — xem lô nhập Excel." : p.note ? `Ghi chú Excel: ${p.note}` : null;
      const opsNote = [p.checkinNote ? `Giờ check-in (Excel): ${p.checkinNote}` : null, p.statusText ? `Tình trạng (Excel): ${p.statusText}` : null, `Nhập từ sheet ${row.sheet} dòng ${row.row_number}`]
        .filter(Boolean)
        .join("\n");
      const created = await tx.query<{ id: string; org_id: string; version: number }>(
        `INSERT INTO bookings (org_id, source_channel, source_account, external_ref, guest_id, booking_status, stay_status, payment_status,
                               check_in_date, check_out_date, total_guests, currency, booking_created_at, channel_note, ops_note, created_by, is_demo)
         VALUES ($1,$2,$3,$4,$5,'confirmed',$6,'unknown',$7,$8,$9,'EUR',$10,$11,$12,$13,$14)
         RETURNING id, org_id, version`,
        [importer.orgId, channel, sourceAccount, ref, guest.rows[0].id, stayStatus, checkIn, checkOut, p.totalGuests, bookedAt, channelNote, opsNote.slice(0, 2000), importer.userId, isDemo],
      );
      const booking = created.rows[0];
      await insertAllocation(tx, importer.orgId, booking.id, { unitId, startDate: checkIn, endDate: checkOut, guests: p.totalGuests }, { onConflict: "throw" });
      await recordBookingChange(tx, booking, "imported", null, {
        actorType: "import",
        actorId: importer.userId,
        source: "excel",
        sourceRef: `${batchId}:${row.sheet}:${row.row_number}`,
      });
      await writeAudit(tx, auditActorOf(importer), "booking.import", "booking", booking.id, {
        batchId,
        sheet: row.sheet,
        rowNumber: row.row_number,
        sourceChannel: channel,
        sourceAccount,
        externalRef: ref,
      });
      await tx.query("UPDATE import_rows SET disposition = 'applied', booking_id = $2 WHERE id = $1", [row.id, booking.id]);
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
  assertBatchId(batchId);
  if (opts.skipCheckOutBefore && !/^\d{4}-\d{2}-\d{2}$/.test(opts.skipCheckOutBefore)) throw invalid("Mốc ngày không hợp lệ (YYYY-MM-DD).");

  const runId = crypto.randomUUID();
  const batchInfo = await withTx(async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      status: string;
      file_sha256: string;
      options: { applying?: { runId: string; startedAt: string }; sourceAccount?: unknown };
      is_demo: boolean;
    }>(
      "SELECT b.id, b.status, b.file_sha256, b.options, o.is_demo FROM import_batches b JOIN organizations o ON o.id = b.org_id WHERE b.id = $1 AND b.org_id = $2 FOR UPDATE OF b",
      [batchId, actor.orgId],
    );
    const batch = rows[0];
    if (!batch) throw notFound("lô nhập");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340))", [`${actor.orgId}|${batch.file_sha256}`]);
    if (batch.status === "discarded") throw conflict("batch_discarded", "Lô này đã bị huỷ.");
    const running = batch.options?.applying;
    if (running && Date.now() - new Date(running.startedAt).getTime() < APPLY_STALE_MS) {
      throw conflict("batch_applying", "Lô này đang được áp dụng ở một yêu cầu khác. Đợi xong rồi tải lại trang.", { startedAt: running.startedAt });
    }
    const other = await tx.query<{ id: string }>(
      "SELECT id FROM import_batches WHERE org_id = $1 AND file_sha256 = $2 AND status = 'applied' AND id <> $3 LIMIT 1",
      [actor.orgId, batch.file_sha256, batchId],
    );
    if (other.rows[0]) throw conflict("file_already_applied", "File này (cùng nội dung) đã được áp dụng ở lô khác.", { batchId: other.rows[0].id });
    const left = await tx.query("SELECT 1 FROM import_rows WHERE batch_id = $1 AND disposition = 'ready' LIMIT 1", [batchId]);
    if (!left.rows.length) {
      if (batch.status === "applied") throw conflict("batch_already_applied", "Lô này đã được áp dụng.");
      // Không khoá sha256 của file khi chẳng có gì để nhập.
      throw conflict("no_ready_rows", "Lô không có dòng hợp lệ nào để áp dụng.");
    }
    if (batch.status !== "applied") {
      await tx.query("UPDATE import_batches SET status = 'applied', applied_by = $2, applied_at = now() WHERE id = $1", [batchId, actor.userId]);
    }
    await tx.query("UPDATE import_batches SET options = options || jsonb_build_object('applying', jsonb_build_object('runId', $2::text, 'startedAt', now())) WHERE id = $1", [
      batchId,
      runId,
    ]);
    // Lô cũ (trước khi có chọn tài khoản) không có khoá này ⇒ giữ nguyên '' như dữ liệu đã nhập.
    const sourceAccount = typeof batch.options?.sourceAccount === "string" ? batch.options.sourceAccount : "";
    await writeAudit(tx, auditActorOf(actor), "import.apply_started", "import_batch", batchId, { runId, sourceAccount, skipCheckOutBefore: opts.skipCheckOutBefore ?? null });
    return { isDemo: batch.is_demo, sourceAccount };
  });
  try {
    return await runApply(actor, batchId, opts, batchInfo.isDemo, runId, batchInfo.sourceAccount);
  } finally {
    await query("UPDATE import_batches SET options = options - 'applying' WHERE id = $1 AND options->'applying'->>'runId' = $2", [batchId, runId]);
  }
}

async function runApply(actor: Actor, batchId: string, opts: ApplyOptions, isDemo: boolean, runId: string, sourceAccount: string): Promise<ApplyResult> {

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
      const upd = await query("UPDATE import_rows SET disposition = 'skipped', issues = $2 WHERE id = $1 AND disposition = 'ready' RETURNING id", [row.id, JSON.stringify(issues)]);
      if (upd.length) result.skipped += 1;
      continue;
    }
    const outcome = await applyRow(importer, batchId, row, today, isDemo, sourceAccount);
    if (outcome.disposition === "not_ready") continue;
    if (outcome.disposition === "error") {
      // Giao dịch của dòng đã huỷ ⇒ ghi lỗi riêng, vẫn chỉ khi dòng còn 'ready'.
      const upd = await query("UPDATE import_rows SET disposition = 'error', issues = $2 WHERE id = $1 AND disposition = 'ready' RETURNING id", [row.id, JSON.stringify([...row.issues, outcome.error])]);
      if (upd.length) result.errors += 1;
    } else if (outcome.disposition === "applied") {
      result.applied += 1;
    } else {
      result.alreadyImported += 1;
    }
  }

  const stats = await recomputeStats(actor.orgId, batchId, { ...result, sourceAccount, finishedAt: new Date().toISOString(), skipCheckOutBefore: opts.skipCheckOutBefore ?? null });
  await writeAudit(null, auditActorOf(actor), "import.apply_finished", "import_batch", batchId, { runId, sourceAccount, ...result });
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
  assertCan(actor, "import.apply");
  assertBatchId(batchId);
  const row = await queryOne<{ status: string }>("SELECT status FROM import_batches WHERE id = $1 AND org_id = $2", [batchId, actor.orgId]);
  if (!row) throw notFound("lô nhập");
  if (row.status !== "previewed") throw conflict("batch_not_previewed", "Chỉ huỷ được lô chưa áp dụng.");
  const changed = await query("UPDATE import_batches SET status = 'discarded' WHERE id = $1 AND org_id = $2 AND status = 'previewed' RETURNING id", [batchId, actor.orgId]);
  if (!changed.length) throw conflict("batch_not_previewed", "Lô vừa được áp dụng ở yêu cầu khác — không huỷ được.");
  await writeAudit(null, auditActorOf(actor), "import.discard", "import_batch", batchId, {});
  return { id: batchId, status: "discarded" };
}

