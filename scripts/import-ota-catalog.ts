/**
 * Nhập danh mục nhà / phòng / sản phẩm / listing THẬT từ file JSON mô tả chỗ nghỉ trên kênh bán.
 *
 *   Xem trước, KHÔNG ghi DB:  npx tsx scripts/import-ota-catalog.ts --file <json> --dry-run
 *   Ghi vào tổ chức:          npx tsx scripts/import-ota-catalog.ts --file <json> --apply [--org <slug>]
 *
 * `--org` ghi đè `orgSlug` trong file. Tổ chức DEMO bị từ chối. Chạy lại nhiều lần chỉ cập nhật tên/sức chứa,
 * không sinh bản ghi trùng, không xoá gì. Mọi bản ghi mới ở trạng thái "cần xác nhận".
 *
 * Chỉ chạy trên máy dev; KHÔNG chạy trên server production.
 */
import fs from "node:fs";
import { loadLocalEnv } from "../src/lib/env";

function args() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { file: get("file"), org: get("org"), dryRun: argv.includes("--dry-run"), apply: argv.includes("--apply") };
}

const pad = (s: string, n: number) => s.padEnd(n);

async function main() {
  const a = args();
  if (!a.file || a.dryRun === a.apply) {
    console.error("Cách dùng: --file <json> (--dry-run | --apply) [--org <slug>]");
    process.exit(2);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(a.file, "utf8"));
  } catch (error) {
    console.error(`Không đọc được JSON: ${(error as Error).message}`);
    process.exit(2);
  }

  const { parseOtaCatalog, importOtaCatalog } = await import("../src/modules/imports/ota-catalog");
  const file = parseOtaCatalog(raw);
  if (a.org) file.orgSlug = a.org;

  console.log(`Tổ chức: ${file.orgSlug} · kênh: ${file.channel} · nhà trong file: ${file.properties.length}`);

  loadLocalEnv();
  const { closePool } = await import("../src/lib/db");
  try {
    const result = await importOtaCatalog(file, { dryRun: a.dryRun });
    for (const p of result.properties) {
      console.log(`\n  ${pad(p.code, 12)} ${p.name}  [nhà: ${p.action}]`);
      for (const r of p.resources) console.log(`    phòng vật lý  ${pad(r.code, 24)} ${r.action}`);
      for (const u of p.units) {
        const links = u.action === "create" ? ` gồm ${u.resourceCodes.join(", ")}` : u.missingResourceCodes.length ? ` THIẾU ${u.missingResourceCodes.join(", ")}` : "";
        console.log(`    sản phẩm      ${pad(u.code, 24)} ${pad(u.kind, 6)} ${String(u.capacity).padStart(2)} khách  ${u.action}${links}`);
        if (u.listing) console.log(`      listing     ${pad(u.listing.channel, 24)} ${u.listing.action}${u.listing.externalListingId ? ` (mã kênh ${u.listing.externalListingId})` : ""}`);
      }
    }

    const c = result.counts;
    console.log("\nTổng kết (tạo / cập nhật / giữ nguyên):");
    for (const [label, v] of [["Nhà", c.properties], ["Phòng vật lý", c.resources], ["Sản phẩm", c.units], ["Listing", c.listings]] as const) {
      console.log(`  ${pad(label, 14)} ${String(v.create).padStart(4)} / ${String(v.update).padStart(4)} / ${String(v.unchanged).padStart(4)}`);
    }
    if (result.aliases) console.log(`  Alias mới: ${result.aliases.created} · trùng nhau: ${result.aliases.collisions} · đã thuộc sản phẩm khác: ${result.aliases.takenByOtherUnit}`);

    console.log(`\nCần xem lại (${result.warnings.length}):`);
    for (const w of result.warnings) console.log(`  - ${w}`);

    const touched = Object.values(c).reduce((n, v) => n + v.create + v.update, 0);
    console.log(
      result.dryRun
        ? "\nDRY-RUN: không ghi gì vào database."
        : touched
          ? "\nĐã ghi. Mọi bản ghi mới ở trạng thái cần xác nhận."
          : "\nDanh mục đã khớp với file — không có gì phải ghi.",
    );
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${(error as { code?: string }).code ?? "error"}: ${error.message}` : error);
  process.exit(1);
});
