import { describe, expect, it } from "vitest";
import { pool, query, queryOne } from "@/lib/db";
import { createBooking } from "@/modules/booking/service";
import { importOtaCatalog, parseOtaCatalog } from "@/modules/imports/ota-catalog";
import { findConflicts } from "@/modules/inventory/inventory";
import { bookingInput, expectCode, makeFixture, uid } from "./helpers";

/** File mẫu theo đúng định dạng người khác sẽ cung cấp (một nhà Booking.com: 2 phòng lẻ + nguyên căn). */
function fileFor(orgSlug: string, s: string, overrides: { bedroomName?: string; wholeCapacity?: number } = {}) {
  return {
    orgSlug,
    channel: "booking_com",
    properties: [
      {
        code: `ULLOI66-${s}`,
        name: "Üllői út 66a",
        address: "66a Üllői út, Budapest",
        externalId: "12171694",
        externalName: "Private Bedroom in the Apartment in Ulloi 66",
        rooms: [
          { code: `ULLOI66-BEDROOM-${s}`, name: overrides.bedroomName ?? "Bedroom", kind: "room", capacity: 2, externalRoomName: "Bedroom Ulloi 6" },
          { code: `ULLOI66-BABY-${s}`, name: "Baby Room", kind: "room", capacity: 2 },
        ],
        wholeUnit: { code: `ULLOI66-WHOLE-${s}`, name: "Nguyên căn Üllői 66", capacity: overrides.wholeCapacity ?? 8 },
      },
    ],
  };
}

/** Tổ chức thử của `makeFixture` mang cờ DEMO; danh mục thật chỉ nhập vào tổ chức không phải DEMO. */
async function realOrg() {
  const f = await makeFixture();
  await query("UPDATE organizations SET is_demo = false WHERE id = $1", [f.orgId]);
  const org = await queryOne<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [f.orgId]);
  return { ...f, slug: org!.slug };
}

const unitIdOf = async (orgId: string, code: string) =>
  (await queryOne<{ id: string }>("SELECT id FROM units WHERE org_id = $1 AND code = $2", [orgId, code]))!.id;

describe("Nhập danh mục từ file kênh bán (JSON)", () => {
  it("từ chối tổ chức DEMO và file sai định dạng", async () => {
    const f = await makeFixture(); // vẫn là DEMO
    const org = await queryOne<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [f.orgId]);
    await expectCode(importOtaCatalog(parseOtaCatalog(fileFor(org!.slug, uid()))), "demo_org");
    await expectCode(importOtaCatalog(parseOtaCatalog(fileFor(`khong-co-${uid()}`, uid()))), "not_found");

    const s = uid();
    const dup = fileFor("x", s);
    dup.properties[0].rooms[1].code = dup.properties[0].rooms[0].code;
    expect(() => parseOtaCatalog(dup)).toThrowError(/xuất hiện ở cả nhà/);
  });

  it("tạo nhà, phòng vật lý, sản phẩm, quan hệ tồn và listing theo kênh", async () => {
    const f = await realOrg();
    const s = uid();
    const r = await importOtaCatalog(parseOtaCatalog(fileFor(f.slug, s)));

    expect(r.counts.properties).toMatchObject({ create: 1 });
    expect(r.counts.resources).toMatchObject({ create: 2 });
    expect(r.counts.units).toMatchObject({ create: 3 });
    expect(r.counts.listings).toMatchObject({ create: 3 });

    // Nguyên căn gồm đúng hai phòng vật lý của nhà đó.
    const whole = await query<{ code: string }>(
      `SELECT res.code FROM unit_resources ur JOIN units u ON u.id = ur.unit_id JOIN resources res ON res.id = ur.resource_id
        WHERE u.org_id = $1 AND u.code = $2 ORDER BY res.code`,
      [f.orgId, `ULLOI66-WHOLE-${s}`],
    );
    expect(whole.map((x) => x.code)).toEqual([`R-ULLOI66-BABY-${s}`, `R-ULLOI66-BEDROOM-${s}`]);

    // Mọi bản ghi mới ở trạng thái cần xác nhận.
    const statuses = await query<{ data_status: string }>(
      `SELECT data_status FROM units WHERE org_id = $1 AND code LIKE $2
       UNION ALL SELECT l.data_status FROM channel_listings l JOIN units u ON u.id = l.unit_id WHERE l.org_id = $1 AND u.code LIKE $2
       UNION ALL SELECT data_status FROM properties WHERE org_id = $1 AND code LIKE $2`,
      [f.orgId, `ULLOI66%${s}`],
    );
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((x) => x.data_status === "needs_confirmation")).toBe(true);

    // Mã/tên bên kênh đi vào listing.
    const bedroom = await queryOne<{ channel: string; listing_name: string; external_listing_id: string; capacity_on_channel: number; status: string }>(
      `SELECT l.channel, l.listing_name, l.external_listing_id, l.capacity_on_channel, l.status
         FROM channel_listings l JOIN units u ON u.id = l.unit_id WHERE u.org_id = $1 AND u.code = $2`,
      [f.orgId, `ULLOI66-BEDROOM-${s}`],
    );
    expect(bedroom).toMatchObject({ channel: "booking_com", listing_name: "Bedroom Ulloi 6", external_listing_id: "12171694", capacity_on_channel: 2, status: "active" });
    // Phòng không có tên riêng bên kênh vẫn được liên kết bằng mã chỗ nghỉ.
    const baby = await queryOne<{ listing_name: string | null; external_listing_id: string }>(
      `SELECT l.listing_name, l.external_listing_id FROM channel_listings l JOIN units u ON u.id = l.unit_id WHERE u.org_id = $1 AND u.code = $2`,
      [f.orgId, `ULLOI66-BABY-${s}`],
    );
    expect(baby).toMatchObject({ listing_name: null, external_listing_id: "12171694" });

    const audit = await query<{ actor_type: string; entity_type: string }>(
      "SELECT actor_type, entity_type FROM audit_log WHERE org_id = $1 AND action = 'catalog.ota_import'",
      [f.orgId],
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((x) => x.actor_type === "system")).toBe(true);
    expect(audit.map((x) => x.entity_type)).toContain("organization");
  });

  it("chạy lại lần hai không nhân bản, chỉ cập nhật tên và sức chứa", async () => {
    const f = await realOrg();
    const s = uid();
    await importOtaCatalog(parseOtaCatalog(fileFor(f.slug, s)));
    const before = await query("SELECT id FROM units WHERE org_id = $1", [f.orgId]);

    const again = await importOtaCatalog(parseOtaCatalog(fileFor(f.slug, s, { bedroomName: "Bedroom (đổi tên)", wholeCapacity: 9 })));
    expect(again.counts.properties).toMatchObject({ create: 0, update: 0, unchanged: 1 });
    expect(again.counts.resources).toMatchObject({ create: 0, update: 1 });
    expect(again.counts.units).toMatchObject({ create: 0, update: 2, unchanged: 1 });
    expect(again.counts.listings.create).toBe(0);

    const after = await query("SELECT id FROM units WHERE org_id = $1", [f.orgId]);
    expect(after.length).toBe(before.length);
    const counts = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM channel_listings l JOIN units u ON u.id = l.unit_id WHERE l.org_id = $1 AND u.code LIKE $2`,
      [f.orgId, `ULLOI66%${s}`],
    );
    expect(counts[0].n).toBe(3);
    const links = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM unit_resources ur JOIN units u ON u.id = ur.unit_id WHERE ur.org_id = $1 AND u.code = $2`,
      [f.orgId, `ULLOI66-WHOLE-${s}`],
    );
    expect(links[0].n).toBe(2);
    const changed = await queryOne<{ name: string; capacity: number }>("SELECT name, capacity FROM units WHERE org_id = $1 AND code = $2", [f.orgId, `ULLOI66-WHOLE-${s}`]);
    expect(changed).toMatchObject({ capacity: 9 });
    const room = await queryOne<{ name: string }>("SELECT name FROM units WHERE org_id = $1 AND code = $2", [f.orgId, `ULLOI66-BEDROOM-${s}`]);
    expect(room!.name).toBe("Bedroom (đổi tên)");
  });

  it("nguyên căn vừa nhập chặn phòng lẻ cùng nhà", async () => {
    const f = await realOrg();
    const s = uid();
    await importOtaCatalog(parseOtaCatalog(fileFor(f.slug, s)));
    const wholeId = await unitIdOf(f.orgId, `ULLOI66-WHOLE-${s}`);
    const bedroomId = await unitIdOf(f.orgId, `ULLOI66-BEDROOM-${s}`);
    const babyId = await unitIdOf(f.orgId, `ULLOI66-BABY-${s}`);

    await createBooking(f.actors.vn_staff, bookingInput(wholeId, "2026-10-01", "2026-10-04"));
    const conflicts = await findConflicts(pool(), f.orgId, bedroomId, "2026-10-02", "2026-10-03");
    expect(conflicts.length).toBeGreaterThan(0);
    await expectCode(createBooking(f.actors.vn_staff, bookingInput(babyId, "2026-10-03", "2026-10-05")), "inventory_conflict");
    // Chiều ngược lại: phòng lẻ đã đặt thì nguyên căn không nhận được nữa.
    await createBooking(f.actors.vn_staff, bookingInput(bedroomId, "2026-11-01", "2026-11-03"));
    await expectCode(createBooking(f.actors.vn_staff, bookingInput(wholeId, "2026-11-02", "2026-11-04")), "inventory_conflict");
    // Phòng lẻ khác vẫn đặt được trong cùng khoảng.
    await createBooking(f.actors.vn_staff, bookingInput(babyId, "2026-11-01", "2026-11-03"));
  });

  it("không dùng lại phòng vật lý của nhà khác — dừng trước khi ghi bất cứ thứ gì", async () => {
    const f = await realOrg();
    const s = uid();
    // Nhà CŨ đã có sẵn tài nguyên đúng mã mà importer sẽ sinh cho phòng NEW-<s> (importer docx dùng cùng quy ước R-<mã>).
    const res = await queryOne<{ id: string }>(
      "INSERT INTO resources (org_id, property_id, code, name, kind) VALUES ($1,$2,$3,'Phòng nhà cũ','room') RETURNING id",
      [f.orgId, f.propertyId, `R-NEW-${s}`],
    );
    const old = await queryOne<{ id: string }>(
      "INSERT INTO units (org_id, property_id, code, name, kind, capacity) VALUES ($1,$2,$3,'Sản phẩm nhà cũ','room',2) RETURNING id",
      [f.orgId, f.propertyId, `OLD-${s}`],
    );
    await query("INSERT INTO unit_resources (unit_id, resource_id, org_id) VALUES ($1,$2,$3)", [old!.id, res!.id, f.orgId]);

    const file = {
      orgSlug: f.slug,
      channel: "booking_com",
      properties: [
        {
          code: `PNEW-${s}`,
          name: "Nhà mới",
          externalId: "999",
          rooms: [{ code: `NEW-${s}`, name: "Phòng mới", kind: "room", capacity: 2 }],
          wholeUnit: { code: `PNEW-WHOLE-${s}`, name: "Nguyên căn nhà mới", capacity: 4 },
        },
      ],
    };
    const err = await expectCode(importOtaCatalog(parseOtaCatalog(file)), "invalid_input");
    expect(err.message).toContain(`R-NEW-${s}`);
    await expectCode(importOtaCatalog(parseOtaCatalog(file), { dryRun: true }), "invalid_input");

    // Không ghi gì: nhà mới chưa tạo, tài nguyên nhà cũ giữ nguyên tên/nhà, không có liên kết chéo nhà.
    expect(await queryOne("SELECT id FROM properties WHERE org_id = $1 AND code = $2", [f.orgId, `PNEW-${s}`])).toBeNull();
    expect(await queryOne("SELECT id FROM units WHERE org_id = $1 AND code = $2", [f.orgId, `NEW-${s}`])).toBeNull();
    const kept = await queryOne<{ name: string; property_id: string }>("SELECT name, property_id FROM resources WHERE org_id = $1 AND code = $2", [f.orgId, `R-NEW-${s}`]);
    expect(kept).toMatchObject({ name: "Phòng nhà cũ", property_id: f.propertyId });
    const links = await query<{ unit_id: string }>("SELECT unit_id FROM unit_resources WHERE org_id = $1 AND resource_id = $2", [f.orgId, res!.id]);
    expect(links.map((l) => l.unit_id)).toEqual([old!.id]);
    expect(await query("SELECT id FROM audit_log WHERE org_id = $1 AND action = 'catalog.ota_import'", [f.orgId])).toEqual([]);
  });

  it("không nhận sản phẩm đã thuộc nhà khác", async () => {
    const f = await realOrg();
    const s = uid();
    await importOtaCatalog(parseOtaCatalog(fileFor(f.slug, s)));

    // Nhà thứ hai khai lại đúng mã nguyên căn của nhà đầu (mã tài nguyên không đụng nhau nên lỗi rơi vào sản phẩm).
    const file = {
      orgSlug: f.slug,
      channel: "booking_com",
      properties: [
        {
          code: `KHAC-${s}`,
          name: "Nhà khác",
          externalId: "888",
          rooms: [{ code: `KHAC-ROOM-${s}`, name: "Phòng nhà khác", kind: "room", capacity: 2 }],
          wholeUnit: { code: `ULLOI66-WHOLE-${s}`, name: "Nguyên căn trùng mã", capacity: 4 },
        },
      ],
    };
    const err = await expectCode(importOtaCatalog(parseOtaCatalog(file)), "invalid_input");
    expect(err.message).toContain(`ULLOI66-${s}`);
    expect(await queryOne("SELECT id FROM properties WHERE org_id = $1 AND code = $2", [f.orgId, `KHAC-${s}`])).toBeNull();
    expect(await queryOne("SELECT id FROM resources WHERE org_id = $1 AND code = $2", [f.orgId, `R-KHAC-ROOM-${s}`])).toBeNull();
    const whole = await queryOne<{ name: string; capacity: number }>("SELECT name, capacity FROM units WHERE org_id = $1 AND code = $2", [f.orgId, `ULLOI66-WHOLE-${s}`]);
    expect(whole).toMatchObject({ name: "Nguyên căn Üllői 66", capacity: 8 });
  });

  it("dry-run báo đúng việc sẽ làm nhưng không ghi gì", async () => {
    const f = await realOrg();
    const s = uid();
    const plan = await importOtaCatalog(parseOtaCatalog(fileFor(f.slug, s)), { dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.counts.units).toMatchObject({ create: 3, update: 0 });
    expect(plan.aliases).toBeNull();

    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM properties WHERE org_id = $1 AND code LIKE $2
       UNION ALL SELECT count(*)::int FROM units WHERE org_id = $1 AND code LIKE $2
       UNION ALL SELECT count(*)::int FROM resources WHERE org_id = $1 AND code LIKE $2
       UNION ALL SELECT count(*)::int FROM audit_log WHERE org_id = $1 AND action = 'catalog.ota_import'`,
      [f.orgId, `%ULLOI66%${s}`],
    );
    expect(rows.map((r) => r.n)).toEqual([0, 0, 0, 0]);

    // Sau dry-run vẫn nhập thật được.
    const done = await importOtaCatalog(parseOtaCatalog(fileFor(f.slug, s)));
    expect(done.counts.units.create).toBe(3);
  });

  it("file khai tài khoản kênh ⇒ listing gắn connector_id; nhãn lạ thì dừng trước khi ghi; chạy lại không đẻ listing mới", async () => {
    const f = await realOrg();
    const s = uid();
    const label = `BDC ${s}`;
    const connectorId = (
      await queryOne<{ id: string }>("INSERT INTO connector_accounts (org_id, channel, label, status) VALUES ($1,'booking_com',$2,'not_configured') RETURNING id", [f.orgId, label])
    )!.id;

    // Nhãn không có trong connector_accounts ⇒ dừng, chưa ghi gì (không tự đẻ tài khoản ma).
    await expectCode(importOtaCatalog(parseOtaCatalog({ ...fileFor(f.slug, s), accountLabel: `Khong co ${s}` })), "not_found");
    expect((await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM units WHERE org_id = $1 AND code LIKE $2", [f.orgId, `%ULLOI66%${s}`]))?.n).toBe(0);

    const r = await importOtaCatalog(parseOtaCatalog({ ...fileFor(f.slug, s), accountLabel: label }));
    expect(r.counts.listings).toMatchObject({ create: 3 });
    const listings = await query<{ connector_id: string | null; account_label: string | null }>(
      `SELECT cl.connector_id, cl.account_label FROM channel_listings cl JOIN units u ON u.id = cl.unit_id WHERE u.org_id = $1 AND u.code LIKE $2`,
      [f.orgId, `%ULLOI66%${s}`],
    );
    expect(listings).toHaveLength(3);
    expect(listings.every((l) => l.connector_id === connectorId && l.account_label === label)).toBe(true);

    // Chạy lại cùng file: nhận đúng listing của tài khoản đó, không tạo thêm.
    const again = await importOtaCatalog(parseOtaCatalog({ ...fileFor(f.slug, s), accountLabel: label }));
    expect(again.counts.listings).toMatchObject({ create: 0 });
    const n = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM channel_listings cl JOIN units u ON u.id = cl.unit_id WHERE u.org_id = $1 AND u.code LIKE $2`,
      [f.orgId, `%ULLOI66%${s}`],
    );
    expect(n?.n).toBe(3);
  });
});
