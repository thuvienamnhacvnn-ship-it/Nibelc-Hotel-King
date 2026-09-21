/**
 * Nhập file Excel "Danh sách lịch đặt phòng" từ dòng lệnh.
 *
 *   Xem trước, KHÔNG ghi DB, tra phòng theo danh mục docx:
 *     npx tsx scripts/import-excel.ts --file <xlsx> --dry-run --catalog-docx <docx>
 *   Xem trước, KHÔNG ghi DB, tra phòng theo DB của tổ chức:
 *     npx tsx scripts/import-excel.ts --file <xlsx> --dry-run --org <slug>
 *   Ghi vào DB (lưu lô xem trước rồi áp dụng dòng hợp lệ):
 *     npx tsx scripts/import-excel.ts --file <xlsx> --org <slug> --apply [--sheet TH] [--skip-before YYYY-MM-DD]
 *     Nhiều tài khoản OTA cùng kênh thì BẮT BUỘC có --account <nhãn tài khoản> (ghi vào bookings.source_account).
 *     Nhãn phải khớp một connector_accounts.label có thật của tổ chức — không nhận nhãn gõ tự do.
 *
 * Chỉ in số đếm, mã lý do và tên phòng chưa có alias — không in tên khách, SĐT hay mã booking.
 */
import fs from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "../src/lib/env";

function args() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    file: get("file"),
    sheet: get("sheet") ?? "TH",
    org: get("org"),
    account: get("account"),
    catalogDocx: get("catalog-docx"),
    skipBefore: get("skip-before"),
    dryRun: argv.includes("--dry-run"),
    apply: argv.includes("--apply"),
  };
}

function printStats(stats: { total: number; byDisposition: Record<string, number>; byIssue: Record<string, number>; bySheet: Record<string, number> }, labels: { d: Record<string, string>; i: Record<string, string> }) {
  console.log(`\nTổng số dòng lưu vào lô: ${stats.total}`);
  console.log("Theo sheet:");
  for (const [k, v] of Object.entries(stats.bySheet)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log("Theo hướng xử lý:");
  for (const [k, v] of Object.entries(stats.byDisposition).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${labels.d[k] ?? ""}`);
  console.log("Theo mã lý do (số dòng có lý do đó):");
  for (const [k, v] of Object.entries(stats.byIssue).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${String(v).padStart(5)}  ${labels.i[k] ?? ""}`);
}

async function main() {
  const a = args();
  if (!a.file || (!a.dryRun && !a.apply) || (a.dryRun && a.apply)) {
    console.error("Cách dùng: --file <xlsx> (--dry-run [--catalog-docx <docx> | --org <slug>] | --org <slug> --apply) [--sheet TH] [--account <nhãn tài khoản>] [--skip-before YYYY-MM-DD]");
    process.exit(2);
  }
  const data = fs.readFileSync(a.file);
  const fileName = path.basename(a.file);
  const excel = await import("../src/modules/imports/excel");
  const labels = { d: excel.DISPOSITION_LABELS, i: excel.ISSUE_LABELS };

  if (a.dryRun) {
    let lookup: import("../src/modules/imports/excel").UnitLookup;
    let closePool: (() => Promise<void>) | null = null;
    if (a.catalogDocx) {
      const { parseCatalogDocx } = await import("../src/modules/imports/catalog-docx");
      const { buildLookup } = await import("../src/modules/imports/aliases");
      const catalog = await parseCatalogDocx(fs.readFileSync(a.catalogDocx));
      const units = catalog.houses.flatMap((h) => h.units.map((u) => ({ unitId: null, code: u.code, name: u.name, kind: u.kind, capacity: u.capacity })));
      const built = buildLookup(units, { fromNames: true });
      lookup = built.lookup;
      console.log(`Tra phòng theo danh mục docx: ${units.length} mã sản phẩm, ${lookup.size} khoá tra (mã + alias), ${built.collisions.length} alias mơ hồ bị bỏ`);
      for (const c of built.collisions) console.log(`  alias mơ hồ "${c.alias}": ${c.codes.join(", ")}`);
    } else if (a.org) {
      loadLocalEnv();
      const db = await import("../src/lib/db");
      closePool = db.closePool;
      const org = await db.queryOne<{ id: string }>("SELECT id FROM organizations WHERE slug = $1", [a.org]);
      if (!org) throw new Error(`Không có tổ chức ${a.org}`);
      const { loadUnitLookup } = await import("../src/modules/imports/aliases");
      lookup = await loadUnitLookup(org.id);
      console.log(`Tra phòng theo DB tổ chức ${a.org}: ${lookup.size} khoá tra (chỉ đọc)`);
    } else {
      console.error("--dry-run cần --catalog-docx <docx> hoặc --org <slug> để tra căn/phòng.");
      process.exit(2);
    }
    const result = await excel.parseBookingWorkbook(data, { sourceSheet: a.sheet, lookup });
    console.log(`\nFile: ${fileName}  sha256: ${(await import("node:crypto")).createHash("sha256").update(data).digest("hex").slice(0, 16)}…  sheet nguồn: ${result.sourceSheet}`);
    console.log("Sheet:");
    for (const s of result.sheets) {
      const rec = s.reconciliation
        ? `  đối chiếu: có mã ${s.reconciliation.withRef}, khớp ${s.reconciliation.matched}, lệch ngày ${s.reconciliation.mismatched}, chỉ ở sheet nhà ${s.reconciliation.onlyInHouse}, không mã ${s.reconciliation.noRef}`
        : "";
      console.log(`  [${s.role}] "${s.name}" tiêu đề dòng ${s.headerRow ?? "—"}, ${s.dataRows} dòng dữ liệu${rec}`);
    }
    printStats(excel.summarizeRows(result.rows), labels);
    const source = result.rows.filter((r) => r.sheet === result.sourceSheet);
    const dupGroups = new Set(source.filter((r) => r.issues.some((i) => i.code === "duplicate_ref_in_file")).map((r) => r.parsed.externalRef));
    console.log(`\nNhóm mã lặp trong sheet nguồn: ${dupGroups.size}`);
    const unmapped = new Map<string, number>();
    for (const r of source) for (const p of r.parsed.unitParts) if (!p.unitCode) unmapped.set(p.alias, (unmapped.get(p.alias) ?? 0) + 1);
    console.log(`Tên căn/phòng chưa có alias (khoá chuẩn hoá, ${unmapped.size} khoá — tên phòng, không phải dữ liệu khách):`);
    for (const [k, v] of [...unmapped.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40)) console.log(`  ${String(v).padStart(4)}  ${k}`);
    console.log("\nDRY-RUN: không ghi gì vào database.");
    if (closePool) await closePool();
    return;
  }

  if (!a.org) {
    console.error("--apply cần --org <slug>.");
    process.exit(2);
  }
  loadLocalEnv();
  const db = await import("../src/lib/db");
  try {
    const org = await db.queryOne<{ id: string; timezone: string; is_demo: boolean }>("SELECT id, timezone, is_demo FROM organizations WHERE slug = $1", [a.org]);
    if (!org) throw new Error(`Không có tổ chức ${a.org}`);
    const { systemActor } = await import("../src/modules/auth/actor");
    const { applyImport, previewImport } = await import("../src/modules/imports/service");
    const actor = systemActor(org.id, "import", ["import.preview", "import.apply", "booking.create", "revenue.view"], org.timezone);
    const preview = await previewImport(actor, { fileName, data }, { sourceSheet: a.sheet, sourceAccount: a.account ?? null });
    console.log(`Đã lưu lô xem trước ${preview.batchId} — tài khoản nguồn: ${preview.sourceAccount || "không ghi"}${org.is_demo ? " (tổ chức DEMO)" : ""}`);
    printStats(preview.stats, labels);
    const result = await applyImport(actor, preview.batchId, { skipCheckOutBefore: a.skipBefore ?? null });
    console.log(`\nÁp dụng: tạo ${result.applied}, đã có ${result.alreadyImported}, lỗi ${result.errors}, bỏ qua ${result.skipped}`);
    printStats(result.stats, labels);
  } finally {
    await db.closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${(error as { code?: string }).code ?? "error"}: ${error.message}` : error);
  process.exit(1);
});
