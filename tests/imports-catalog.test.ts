import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { applyCatalog, extractEmails, parseCatalogDocx } from "@/modules/imports/catalog-docx";
import { expectCode, uid } from "./helpers";

/** Mật khẩu giả đặt trong docx thử — không chuỗi nào được xuất hiện trong kết quả parser hay DB. */
const SECRETS = ["Secr3tPass#", "AnotherPw9#", "GluedPw1#", "NoSpacePw77", "TableSecret#5"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const cell = (text: string) => `<w:tc>${text.split("\n").map(p).join("")}</w:tc>`;
const table = (rows: string[][]) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map(cell).join("")}</w:tr>`).join("")}</w:tbl>`;

const HEADER = ["Mã", "Tên nội bộ", "Kênh bán", "Listing name (Tên hiển thị)", "Listing ID / Link", "Sức chứa", "Quan hệ căn - phòng", "Chi tiết phòng"];

async function makeDocx(): Promise<Buffer> {
  const body = [
    p("THÔNG TIN PHỤC VỤ BUILD PLATFORM"),
    p("2. MAPPING KÊNH BÁN"),
    table([["STT", "EMAIL + AIRBNB", "BOOKING.COM"], ["1", `mapping.demo@example.com\nTableSecret#5`, ""]]),
    p("CHI TIẾT TỪNG NHÀ"),
    p("Nhà Demo X- Địa chỉ:"),
    p("Địa chỉ: Demo utca 1, 1000 Budapest"),
    p("Account:"),
    p(`Airbnb: (Nguyên căn) host.demo@example.com – ${SECRETS[0]}`),
    p(`(Lẻ phòng) rooms.demo@example.com - ${SECRETS[1]}`),
    p(`Booking : bk.demo@example.com–${SECRETS[2]}`),
    p(`Booking dự phòng: glued@example.com${SECRETS[3]}`),
    p("Link hình ảnh : https://drive.example.com/folder/demo"),
    table([
      HEADER,
      ["X000", "Demo X", "Airbnb", "Demo X Flat - 3BR for 6", "https://www.airbnb.com/rooms/123456?source=demo", "6", "Nguyên căn", "3 phòng: 1 giường đôi"],
      ["X001", "Little Demo X", "Airbnb", "Little Demo X for 4", "https://www.airbnb.com/rooms/222333", "2", "Phòng lẻ", "1 giường đôi"],
      ["X002", "Baby Room Demo X", "Airbnb", "Đang bị khóa bởi nền tảng", "", "2", "Phòng lẻ", "1 giường đôi"],
      ["X003", "Demo X Studio", "Airbnb", "Demo X Studio near metro", "https://www.airbnb.com/rooms/999888", "4", "Nguyên căn", "2 giường đôi"],
      ["X001", "Little Demo X", "Booking.com", "Double Room (Demo X)", "https://www.booking.com/Share-AbC123", "3", "Phòng lẻ", "1 giường đôi"],
      ["X002", "Baby Room Demo X", "Booking.com", "Double Room (Demo X)", "", "2", "Phòng lẻ", "1 giường đôi"],
      ["X003", "Demo X Studio", "Booking.com", "Studio (Demo X)", "", "4", "Studio", "2 giường đôi"],
    ]),
    p("Nhà Demo Y"),
    p("Địa chỉ: Demo utca 2"),
    p(`Airbnb: y.demo@example.com – ${SECRETS[0]}`),
    table([HEADER, ["Y001", "Demo Y 1", "Airbnb", "Demo Y 1 studio", "https://www.airbnb.com/rooms/555", "2", "Nguyên căn", "1 giường đôi"]]),
    p("3. DỮ LIỆU VẬN HÀNH MẪU"),
    p(`Airbnb: after.section@example.com – ${SECRETS[0]}`),
  ].join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function assertNoSecrets(value: unknown) {
  const json = JSON.stringify(value);
  for (const s of SECRETS) expect(json, `lộ chuỗi mật khẩu thử ${s}`).not.toContain(s);
  for (const fragment of ["Secr3t", "AnotherPw", "GluedPw", "NoSpacePw", "TableSecret"]) expect(json).not.toContain(fragment);
  expect(json).not.toContain("drive.example.com");
}

describe("Đọc danh mục docx Vietnam Team", () => {
  it("chỉ giữ email, không lộ mật khẩu kể cả khi viết dính liền", () => {
    expect(extractEmails("Airbnb: a.b@example.com – pass123#")).toEqual(["a.b@example.com"]);
    expect(extractEmails("Booking: x@example.com–Pw1#")).toEqual(["x@example.com"]);
    expect(extractEmails("dính liền: y@example.comMatKhau9")).toEqual([]);
  });

  it("tách nhà, sản phẩm, tài nguyên, listing và điểm cần xác nhận", async () => {
    const result = await parseCatalogDocx(await makeDocx());
    assertNoSecrets(result);
    expect(result.counts).toMatchObject({ houses: 2, units: 5, listings: 8 });
    const x = result.houses[0];
    expect(x.name).toBe("Demo X");
    expect(x.code).toBe("DEMOX");
    expect(x.address).toBe("Demo utca 1, 1000 Budapest");
    expect(x.accounts).toEqual([
      { channel: "airbnb", scope: "whole", email: "host.demo@example.com" },
      { channel: "airbnb", scope: "room", email: "rooms.demo@example.com" },
      { channel: "booking_com", scope: null, email: "bk.demo@example.com" },
    ]);
    const unit = (code: string) => x.units.find((u) => u.code === code)!;
    expect(unit("X000")).toMatchObject({ kind: "whole", capacity: 6, resourceCodes: ["R-X001", "R-X002"] });
    expect(unit("X000").listings[0]).toMatchObject({ channel: "airbnb", externalListingId: "123456", accountLabel: "host.demo@example.com" });
    expect(unit("X001").listings.find((l) => l.channel === "airbnb")).toMatchObject({ externalListingId: "222333", accountLabel: "rooms.demo@example.com" });
    const bk = unit("X001").listings.find((l) => l.channel === "booking_com")!;
    expect(bk.externalListingId).toBeNull();
    expect(bk.note).toContain("link chia sẻ");
    expect(unit("X002").listings.find((l) => l.channel === "airbnb")).toMatchObject({ status: "blocked_by_platform", listingName: null });
    // Nguyên căn/studio thứ hai: tách tài nguyên riêng, không gắn vào nguyên căn chính
    expect(unit("X003").resourceCodes).toEqual(["R-X003"]);
    expect(unit("X000").resourceCodes).not.toContain("R-X003");

    const reasons = (code: string) => result.confirmations.filter((c) => c.code === code).map((c) => c.reason).join(" | ");
    expect(reasons("X001")).toMatch(/Sức chứa khác nhau giữa kênh/);
    expect(reasons("X001")).toMatch(/tên listing ghi 4 khách nhưng sức chứa 2/);
    expect(reasons("X002")).toMatch(/Đang bị khóa bởi nền tảng/);
    expect(reasons("X003")).toMatch(/Loại sản phẩm khác nhau giữa kênh/);
    expect(reasons("X003")).toMatch(/Quan hệ với X000 chưa rõ/);
    expect(reasons("X000")).toMatch(/Chi tiết ghi 3 phòng nhưng chỉ có 2 phòng lẻ/);
    // Nhà không có phòng lẻ: nguyên căn tự là một tài nguyên
    expect(result.houses[1].units[0].resourceCodes).toEqual(["R-Y001"]);
    // Không đọc sang mục sau phần chi tiết nhà
    expect(JSON.stringify(result)).not.toContain("after.section@example.com");
  });

  it("ghi vào tổ chức thật với trạng thái cần xác nhận; từ chối tổ chức DEMO", async () => {
    const catalog = await parseCatalogDocx(await makeDocx());
    const s = uid();
    await query("INSERT INTO organizations (slug, name, is_demo) VALUES ($1,'Demo org',true)", [`demo-${s}`]);
    await expectCode(applyCatalog(`demo-${s}`, catalog), "demo_org");
    const org = await queryOne<{ id: string }>("INSERT INTO organizations (slug, name, is_demo) VALUES ($1,'Org thật (thử)',false) RETURNING id", [`real-${s}`]);

    const r = await applyCatalog(`real-${s}`, catalog);
    expect(r.units.created).toBe(5);
    expect(r.listings.created).toBe(8);
    expect(r.resources.created).toBe(4);
    expect(r.aliases.created).toBeGreaterThan(0);
    const statuses = await query<{ data_status: string }>(
      `SELECT data_status FROM units WHERE org_id = $1 UNION ALL SELECT data_status FROM channel_listings WHERE org_id = $1 UNION ALL SELECT data_status FROM properties WHERE org_id = $1`,
      [org!.id],
    );
    expect(statuses.every((x) => x.data_status === "needs_confirmation")).toBe(true);
    const x000 = await query<{ code: string }>(
      "SELECT r.code FROM unit_resources ur JOIN units u ON u.id = ur.unit_id JOIN resources r ON r.id = ur.resource_id WHERE u.org_id = $1 AND u.code = 'X000' ORDER BY r.code",
      [org!.id],
    );
    expect(x000.map((x) => x.code)).toEqual(["R-X001", "R-X002"]);
    const dump = await query(
      `SELECT to_jsonb(p) AS p FROM properties p WHERE org_id = $1
       UNION ALL SELECT to_jsonb(l) FROM channel_listings l WHERE org_id = $1
       UNION ALL SELECT to_jsonb(u) FROM units u WHERE org_id = $1
       UNION ALL SELECT to_jsonb(a) FROM audit_log a WHERE org_id = $1`,
      [org!.id],
    );
    assertNoSecrets(dump);

    // Chạy lại không nhân bản
    const again = await applyCatalog(`real-${s}`, catalog);
    expect(again.units).toEqual({ created: 0, existing: 5 });
    expect(again.listings.created).toBe(0);
  });
});
