/**
 * Nhập danh mục nhà / sản phẩm / tài nguyên / listing từ file "Thông tin build app update _Vietnam Team.docx".
 *
 *   Báo cáo, KHÔNG ghi DB:   npx tsx scripts/import-catalog-docx.ts --file <docx> --dry-run
 *   Ghi vào tổ chức:          npx tsx scripts/import-catalog-docx.ts --file <docx> --org <slug> --apply
 *
 * Parser chỉ giữ email tài khoản kênh (không mật khẩu, không link ảnh). Báo cáo chỉ in số lượng và điểm cần xác nhận
 * theo mã sản phẩm — không in địa chỉ, email. --apply từ chối tổ chức DEMO; mọi bản ghi mới ở trạng thái cần xác nhận.
 */
import fs from "node:fs";
import { loadLocalEnv } from "../src/lib/env";

async function main() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = get("file");
  const org = get("org");
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  if (!file || dryRun === apply || (apply && !org)) {
    console.error("Cách dùng: --file <docx> (--dry-run | --org <slug> --apply)");
    process.exit(2);
  }
  const { parseCatalogDocx, applyCatalog } = await import("../src/modules/imports/catalog-docx");
  const catalog = await parseCatalogDocx(fs.readFileSync(file));

  console.log(`Nhà: ${catalog.counts.houses} · mã sản phẩm: ${catalog.counts.units} · tài nguyên phòng: ${catalog.counts.resources} · listing: ${catalog.counts.listings} · email tài khoản: ${catalog.counts.accounts}`);
  for (const h of catalog.houses) {
    const kinds = h.units.reduce<Record<string, number>>((acc, u) => ((acc[u.kind] = (acc[u.kind] ?? 0) + 1), acc), {});
    const byChannel = h.units.flatMap((u) => u.listings).reduce<Record<string, number>>((acc, l) => ((acc[l.channel] = (acc[l.channel] ?? 0) + 1), acc), {});
    const withId = h.units.flatMap((u) => u.listings).filter((l) => l.externalListingId).length;
    console.log(
      `  ${h.code.padEnd(8)} "${h.name}": ${h.units.map((u) => u.code).join(", ")} | loại ${JSON.stringify(kinds)} | listing ${JSON.stringify(byChannel)} (có ID ${withId}) | tài nguyên ${h.resources.length} | email ${h.accounts.length} | địa chỉ ${h.address ? "có" : "thiếu"}`,
    );
  }
  const listings = catalog.houses.flatMap((h) => h.units.flatMap((u) => u.listings));
  const missing = (ch: string) => listings.filter((l) => l.channel === ch && !l.externalListingId).length;
  console.log(`Listing chưa có ID kênh: Airbnb ${missing("airbnb")}/${listings.filter((l) => l.channel === "airbnb").length}, Booking.com ${missing("booking_com")}/${listings.filter((l) => l.channel === "booking_com").length} (link Booking là link chia sẻ)`);
  console.log("Mọi nhà/sản phẩm/listing ghi vào DB đều ở trạng thái cần xác nhận.");
  console.log(`\nĐiểm cần xác nhận cụ thể (${catalog.confirmations.length}):`);
  for (const c of catalog.confirmations) console.log(`  ${c.code.padEnd(8)} ${c.reason}`);

  if (dryRun) {
    console.log("\nDRY-RUN: không ghi gì vào database.");
    return;
  }
  loadLocalEnv();
  const { closePool } = await import("../src/lib/db");
  try {
    const result = await applyCatalog(org!, catalog);
    console.log("\nĐã ghi:", JSON.stringify(result));
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${(error as { code?: string }).code ?? "error"}: ${error.message}` : error);
  process.exit(1);
});
