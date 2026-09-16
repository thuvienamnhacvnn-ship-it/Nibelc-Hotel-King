import JSZip from "jszip";
import { withTx } from "@/lib/db";
import { AppError, conflict, notFound } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/audit";
import { createAliasesInTx } from "./aliases";
import { looseText, normalizeHeader, normalizeUnitAlias } from "./excel/normalize";

/**
 * Đọc danh mục nhà/phòng/listing từ file "Thông tin build app update _Vietnam Team.docx".
 *
 * BẢO MẬT: file gốc có mật khẩu OTA viết chữ thường ngay sau email ("Airbnb: email – mậtkhẩu").
 * Parser chỉ giữ ĐỊA CHỈ EMAIL khớp mẫu chặt (sau email phải là ký tự không phải chữ/số), không giữ bất kỳ chuỗi nào
 * khác của dòng tài khoản, không giữ link ảnh/Drive. Kết quả trả về không chứa văn bản thô của đoạn tài khoản.
 */

export type Channel = "airbnb" | "booking_com";
export type UnitKind = "whole" | "room" | "studio";

export interface CatalogAccount {
  channel: Channel;
  /** "(Lẻ phòng)" → room, "(Nguyên căn)" → whole, không ghi → null */
  scope: "whole" | "room" | null;
  email: string;
}

export interface CatalogListing {
  channel: Channel;
  listingName: string | null;
  externalListingId: string | null;
  capacityOnChannel: number | null;
  kindOnChannel: UnitKind | null;
  status: "active" | "blocked_by_platform" | "unknown";
  accountLabel: string | null;
  note: string | null;
}

export interface CatalogUnit {
  code: string;
  name: string;
  kind: UnitKind;
  capacity: number;
  bedConfig: string | null;
  propertyCode: string;
  resourceCodes: string[];
  listings: CatalogListing[];
  confirmations: string[];
}

export interface CatalogResource {
  code: string;
  name: string;
  kind: "room" | "studio";
  propertyCode: string;
}

export interface CatalogHouse {
  code: string;
  name: string;
  address: string | null;
  accounts: CatalogAccount[];
  units: CatalogUnit[];
  resources: CatalogResource[];
  confirmations: string[];
}

export interface CatalogParseResult {
  houses: CatalogHouse[];
  /** Điểm cần xác nhận: mã sản phẩm (hoặc mã nhà) + lý do. Không chứa địa chỉ/email. */
  confirmations: { code: string; reason: string }[];
  counts: { houses: number; units: number; resources: number; listings: number; accounts: number };
}

// ───────────────────────── Đọc XML của Word ─────────────────────────

const XML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function decodeXml(s: string) {
  return s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, _n, dec, hex) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : XML_ENTITIES[m] ?? m,
  );
}

interface TextWithLinks {
  text: string;
  links: string[];
}

function textOf(xml: string, rels: Map<string, string>): TextWithLinks {
  const links: string[] = [];
  for (const m of xml.matchAll(/<w:hyperlink\b[^>]*r:id="([^"]+)"/g)) {
    const target = rels.get(m[1]);
    if (target) links.push(target);
  }
  // Mỗi đoạn trong ô bảng xuống dòng riêng
  const parts = xml.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>/g) ?? [];
  const text = parts
    .map((t) => (t === "<w:tab/>" ? "\t" : t === "<w:br/>" || t === "</w:p>" ? "\n" : decodeXml(t.replace(/<[^>]+>/g, ""))))
    .join("")
    .replace(/\n+$/, "");
  return { text, links };
}

type Block = { type: "p"; text: string; links: string[] } | { type: "table"; rows: TextWithLinks[][] };

async function readBlocks(buffer: Buffer | Uint8Array | ArrayBuffer): Promise<Block[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new AppError("unreadable_docx", "Không đọc được file .docx.", 422);
  }
  const doc = zip.file("word/document.xml");
  if (!doc) throw new AppError("unreadable_docx", "File .docx thiếu word/document.xml.", 422);
  const xml = await doc.async("string");
  const rels = new Map<string, string>();
  const relFile = zip.file("word/_rels/document.xml.rels");
  if (relFile) {
    const relXml = await relFile.async("string");
    for (const m of relXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
      if (id && target) rels.set(id, decodeXml(target));
    }
  }
  const bodyStart = xml.indexOf("<w:body");
  const body = bodyStart >= 0 ? xml.slice(bodyStart) : xml;
  const blocks: Block[] = [];
  // Bảng lồng hiếm gặp trong file này; bắt bảng cấp cao nhất theo cặp thẻ đầu tiên.
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  for (const m of body.matchAll(re)) {
    const x = m[0];
    if (x.startsWith("<w:tbl>")) {
      const rows = (x.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).map((tr) => (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => textOf(tc, rels)));
      blocks.push({ type: "table", rows });
    } else {
      const t = textOf(x, rels);
      blocks.push({ type: "p", text: t.text.trim(), links: t.links });
    }
  }
  return blocks;
}

// ───────────────────────── Bóc bí mật ─────────────────────────

/**
 * Chỉ trả địa chỉ email. Sau phần tên miền bắt buộc là ký tự không phải chữ/số/dấu chấm, nên chuỗi dính liền kiểu
 * "abc@gmail.commatkhau1" KHÔNG khớp (bị bỏ) thay vì lọt một phần mật khẩu vào tên miền.
 */
export function extractEmails(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|hu|vn|de|io|co|info|biz|eu|uk|me)(?![A-Za-z0-9.])/gi)) {
    out.push(m[0].toLowerCase());
  }
  return out;
}

function channelOfText(s: string): Channel | null {
  const t = looseText(s);
  if (/^airbnb\b/.test(t) || t === "airbnb") return "airbnb";
  if (/^booking\b/.test(t)) return "booking_com";
  return null;
}

function scopeOf(s: string): "whole" | "room" | null {
  const paren = /\(([^)]*)\)/.exec(s)?.[1];
  if (!paren) return null;
  const t = looseText(paren);
  if (/le phong|phong le/.test(t)) return "room";
  if (/nguyen can/.test(t)) return "whole";
  return null;
}

// ───────────────────────── Bảng sản phẩm ─────────────────────────

type Col = "code" | "name" | "channel" | "listing" | "link" | "capacity" | "relation" | "detail";

function columnOf(header: string): Col | null {
  const h = normalizeHeader(header);
  if (h === "ma" || h === "stt" || h === "ma phong") return "code";
  if (h.startsWith("ten noi bo")) return "name";
  if (h.startsWith("kenh ban")) return "channel";
  if (h.startsWith("listing name")) return "listing";
  if (h.startsWith("listing id")) return "link";
  if (h.startsWith("suc chua")) return "capacity";
  if (h.startsWith("quan he")) return "relation";
  if (h.startsWith("chi tiet phong") || h === "khac") return "detail";
  return null;
}

function kindOf(relation: string): UnitKind | null {
  const t = looseText(relation);
  if (/nguyen can/.test(t)) return "whole";
  if (/phong le/.test(t)) return "room";
  if (/studio/.test(t)) return "studio";
  return null;
}

/** Số khách ghi trong tên listing: "for 4", "Sleep 10", "6 Guests", "4-Guest". */
function guestsInListingName(name: string): number | null {
  const m = /\bfor\s+(\d{1,2})\b|\bsleeps?\s+(\d{1,2})\b|\b(\d{1,2})[\s-]*guests?\b/i.exec(name);
  if (!m) return null;
  return Number(m[1] ?? m[2] ?? m[3]);
}

function airbnbRoomId(urls: string[]): string | null {
  for (const u of urls) {
    const m = /\/rooms\/(\d+)/.exec(u);
    if (m) return m[1];
  }
  return null;
}

function houseCode(name: string): string {
  return normalizeUnitAlias(name).replace(/\s+/g, "").toUpperCase() || "NHA";
}

interface RawProductRow {
  code: string;
  name: string;
  channel: Channel | null;
  listing: string;
  links: string[];
  linkText: string;
  capacity: number | null;
  kind: UnitKind | null;
  detail: string | null;
}

function readProductTable(rows: TextWithLinks[][]): RawProductRow[] | null {
  if (rows.length < 2) return null;
  const cols = rows[0].map((c) => columnOf(c.text));
  if (!cols.includes("code") || !cols.includes("name") || !cols.includes("channel")) return null;
  const at = (row: TextWithLinks[], col: Col) => {
    const i = cols.indexOf(col);
    return i >= 0 ? row[i] : undefined;
  };
  const out: RawProductRow[] = [];
  for (const row of rows.slice(1)) {
    const code = at(row, "code")?.text.trim().replace(/\s+/g, "") ?? "";
    if (!code) continue;
    const linkCell = at(row, "link");
    const linkText = linkCell?.text.trim() ?? "";
    const urls = [...(linkCell?.links ?? []), ...(linkText.match(/https?:\/\/\S+/g) ?? [])];
    const cap = /\d+/.exec(at(row, "capacity")?.text ?? "");
    const ch = looseText(at(row, "channel")?.text ?? "");
    out.push({
      code,
      name: (at(row, "name")?.text ?? "").replace(/\s+/g, " ").trim(),
      channel: /airbnb/.test(ch) ? "airbnb" : /booking/.test(ch) ? "booking_com" : null,
      listing: (at(row, "listing")?.text ?? "").replace(/\s+/g, " ").trim(),
      links: urls,
      linkText,
      capacity: cap ? Number(cap[0]) : null,
      kind: kindOf(at(row, "relation")?.text ?? ""),
      detail: (at(row, "detail")?.text ?? "").replace(/\s*\n\s*/g, "; ").trim() || null,
    });
  }
  return out;
}

const CHANNEL_LABEL: Record<Channel, string> = { airbnb: "Airbnb", booking_com: "Booking.com" };

function buildHouse(name: string, address: string | null, accounts: CatalogAccount[], products: RawProductRow[]): CatalogHouse {
  const code = houseCode(name);
  const houseConfirmations: string[] = [];
  const byCode = new Map<string, RawProductRow[]>();
  for (const p of products) byCode.set(p.code, [...(byCode.get(p.code) ?? []), p]);

  const units: CatalogUnit[] = [];
  for (const [unitCode, rows] of byCode) {
    const confirmations: string[] = [];
    const first = rows[0];
    const names = [...new Set(rows.map((r) => r.name).filter(Boolean))];
    if (names.length > 1) confirmations.push(`Tên nội bộ khác nhau giữa các dòng: ${names.join(" / ")}`);
    const kinds = [...new Set(rows.map((r) => r.kind).filter((k): k is UnitKind => !!k))];
    if (kinds.length > 1) confirmations.push(`Loại sản phẩm khác nhau giữa kênh (${rows.map((r) => `${r.channel ? CHANNEL_LABEL[r.channel] : "?"}: ${r.kind ?? "?"}`).join(", ")})`);
    const caps = [...new Set(rows.map((r) => r.capacity).filter((c): c is number => c != null))];
    if (caps.length > 1) confirmations.push(`Sức chứa khác nhau giữa kênh (${rows.map((r) => `${r.channel ? CHANNEL_LABEL[r.channel] : "?"}: ${r.capacity ?? "?"}`).join(", ")})`);
    const kind = first.kind ?? kinds[0] ?? "room";
    if (!first.kind) confirmations.push("Không đọc được quan hệ căn - phòng, tạm coi là phòng lẻ");
    const capacity = Math.max(1, first.capacity ?? caps[0] ?? 1);
    if (first.capacity == null) confirmations.push("Không đọc được sức chứa");

    const listings: CatalogListing[] = rows.map((r) => {
      const notes: string[] = [];
      let externalListingId: string | null = null;
      let status: CatalogListing["status"] = "active";
      let listingName: string | null = r.listing || null;
      if (listingName && /bi khoa/.test(looseText(listingName))) {
        status = "blocked_by_platform";
        confirmations.push(`${r.channel ? CHANNEL_LABEL[r.channel] : "Kênh"}: listing ghi "${listingName}"`);
        notes.push(`File nguồn ghi: ${listingName}`);
        listingName = null;
      }
      if (r.channel === "airbnb") {
        externalListingId = airbnbRoomId(r.links);
        if (!externalListingId && status === "active") {
          status = "unknown";
          notes.push("Không có link Airbnb /rooms/<id>");
          confirmations.push("Airbnb: chưa có listing ID");
        }
      } else if (r.channel === "booking_com") {
        if (r.links.length) notes.push("Link trong file là link chia sẻ Booking.com — không phải property/room ID");
        else notes.push("Chưa có property/room ID Booking.com");
      }
      const named = listingName ? guestsInListingName(listingName) : null;
      if (named != null && r.capacity != null && named !== r.capacity) {
        confirmations.push(`${r.channel ? CHANNEL_LABEL[r.channel] : "Kênh"}: tên listing ghi ${named} khách nhưng sức chứa ${r.capacity}`);
      }
      const account = r.channel ? pickAccount(accounts, r.channel, kind) : null;
      return {
        channel: r.channel ?? "airbnb",
        listingName,
        externalListingId,
        capacityOnChannel: r.capacity,
        kindOnChannel: r.kind,
        status,
        accountLabel: account,
        note: notes.join(". ") || null,
      };
    });
    if (rows.some((r) => !r.channel)) confirmations.push("Có dòng không đọc được kênh bán");
    units.push({ code: unitCode, name: names[0] ?? unitCode, kind, capacity, bedConfig: first.detail, propertyCode: code, resourceCodes: [], listings, confirmations: [...new Set(confirmations)] });
  }

  // Tài nguyên: mỗi phòng lẻ/studio một tài nguyên. Nguyên căn chính gắn mọi phòng lẻ cùng nhà.
  // Nguyên căn/studio khác trong nhà có phòng lẻ: tách riêng + cần xác nhận (ca 6503 — không suy ra quan hệ).
  const resources: CatalogResource[] = [];
  const rooms = units.filter((u) => u.kind === "room");
  const wholes = units.filter((u) => u.kind === "whole");
  const studios = units.filter((u) => u.kind === "studio");
  for (const u of rooms) {
    const rc = `R-${u.code}`;
    resources.push({ code: rc, name: u.name, kind: "room", propertyCode: code });
    u.resourceCodes.push(rc);
  }
  const standalone = (u: CatalogUnit) => {
    const rc = `R-${u.code}`;
    resources.push({ code: rc, name: u.name, kind: "studio", propertyCode: code });
    u.resourceCodes.push(rc);
  };
  if (rooms.length === 0) {
    for (const u of [...wholes, ...studios]) standalone(u);
  } else {
    const [main, ...others] = wholes;
    if (main) {
      main.resourceCodes.push(...rooms.map((r) => `R-${r.code}`));
      const bedRooms = [...(main.bedConfig ?? "").matchAll(/(\d+)\s*phòng/gi)].reduce((s, m) => s + Number(m[1]), 0);
      if (bedRooms > rooms.length) main.confirmations.push(`Chi tiết ghi ${bedRooms} phòng nhưng chỉ có ${rooms.length} phòng lẻ được khai báo — có thể còn phòng không bán lẻ`);
      for (const o of [...others, ...studios]) {
        main.confirmations.push(`Chưa rõ nguyên căn có gồm ${o.code} không — đang không gắn`);
      }
    } else {
      houseConfirmations.push("Nhà có phòng lẻ nhưng không có sản phẩm nguyên căn");
    }
    for (const o of [...others, ...studios]) {
      standalone(o);
      o.confirmations.push(`Quan hệ với ${main?.code ?? "nguyên căn"} chưa rõ — tách thành tài nguyên riêng`);
    }
  }
  if (!address) houseConfirmations.push("Thiếu địa chỉ");
  if (!accounts.length) houseConfirmations.push("Không đọc được email tài khoản kênh");
  return { code, name, address, accounts, units, resources, confirmations: houseConfirmations };
}

function pickAccount(accounts: CatalogAccount[], channel: Channel, kind: UnitKind): string | null {
  const list = accounts.filter((a) => a.channel === channel);
  const scoped = list.find((a) => a.scope === (kind === "whole" ? "whole" : "room"));
  return (scoped ?? list.find((a) => a.scope === null) ?? list[0])?.email ?? null;
}

// ───────────────────────── Toàn văn bản ─────────────────────────

const ADDRESS_RE = /^(?:nh[aà]\s+)?(.*?)\s*-?\s*đ[iị]a\s*ch[iỉ]\s*[:：]?\s*(.*)$/i;

export async function parseCatalogDocx(buffer: Buffer | Uint8Array | ArrayBuffer): Promise<CatalogParseResult> {
  const blocks = await readBlocks(buffer);
  const start = blocks.findIndex((b) => b.type === "p" && /chi tiet tung nha/.test(looseText(b.text)));
  const houses: CatalogHouse[] = [];
  if (start < 0) return finish(houses);

  let current: { name: string; address: string | null; accounts: CatalogAccount[]; products: RawProductRow[]; lastChannel: Channel | null } | null = null;
  const flush = () => {
    if (current && current.products.length) houses.push(buildHouse(current.name, current.address, current.accounts, current.products));
    current = null;
  };
  const nextParagraph = (i: number) => {
    for (let j = i + 1; j < blocks.length; j++) {
      const b = blocks[j];
      if (b.type === "table") return null;
      if (b.text) return b.text;
    }
    return null;
  };
  const isAddress = (t: string) => /^đ[iị]a\s*ch[iỉ]/i.test(t.normalize("NFC"));

  for (let i = start + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "table") {
      const products = readProductTable(b.rows);
      if (products && current) current.products.push(...products);
      continue;
    }
    const t = b.text.normalize("NFC");
    if (!t) continue;
    // Hết phần chi tiết nhà: mục đánh số tiếp theo ("3. DỮ LIỆU VẬN HÀNH MẪU")
    if (/^\d+\s*\.\s*\S/.test(t) && t === t.toUpperCase()) break;

    const inlineAddress = ADDRESS_RE.exec(t);
    if (inlineAddress && inlineAddress[1] && !isAddress(t)) {
      // "Nhà Dob- Địa chỉ:" — tiêu đề nhà và nhãn địa chỉ trên cùng một dòng
      flush();
      current = { name: inlineAddress[1].trim(), address: inlineAddress[2]?.trim() || null, accounts: [], products: [], lastChannel: null };
      continue;
    }
    if (isAddress(t)) {
      if (current && !current.address) current.address = t.replace(/^đ[iị]a\s*ch[iỉ]\s*[:：]?\s*/i, "").trim() || null;
      continue;
    }
    const next = nextParagraph(i);
    if (next && isAddress(next.normalize("NFC")) && !channelOfText(t) && !/@/.test(t)) {
      flush();
      current = { name: t.replace(/^nh[aà]\s+/i, "").replace(/[-:：\s]+$/, "").trim(), address: null, accounts: [], products: [], lastChannel: null };
      continue;
    }
    if (!current) continue;
    const cur = current as NonNullable<typeof current>;
    if (/^account\b/i.test(t) || /^link\b/i.test(looseText(t)) || /^https?:/i.test(t)) continue;
    const channel = channelOfText(t);
    if (channel) cur.lastChannel = channel;
    if ((channel || t.startsWith("(")) && cur.lastChannel) {
      for (const email of extractEmails(t)) cur.accounts.push({ channel: cur.lastChannel, scope: scopeOf(t), email });
    }
  }
  flush();
  return finish(houses);
}

function finish(houses: CatalogHouse[]): CatalogParseResult {
  const confirmations: CatalogParseResult["confirmations"] = [];
  const seenCodes = new Map<string, string>();
  for (const h of houses) {
    for (const reason of h.confirmations) confirmations.push({ code: h.code, reason });
    for (const u of h.units) {
      if (seenCodes.has(u.code)) confirmations.push({ code: u.code, reason: `Mã xuất hiện ở hai nhà (${seenCodes.get(u.code)} và ${h.code})` });
      seenCodes.set(u.code, h.code);
      for (const reason of u.confirmations) confirmations.push({ code: u.code, reason });
    }
  }
  return {
    houses,
    confirmations,
    counts: {
      houses: houses.length,
      units: houses.reduce((s, h) => s + h.units.length, 0),
      resources: houses.reduce((s, h) => s + h.resources.length, 0),
      listings: houses.reduce((s, h) => s + h.units.reduce((x, u) => x + u.listings.length, 0), 0),
      accounts: houses.reduce((s, h) => s + h.accounts.length, 0),
    },
  };
}

// ───────────────────────── Ghi vào tổ chức ─────────────────────────

export interface CatalogApplyResult {
  properties: { created: number; existing: number };
  resources: { created: number; existing: number };
  units: { created: number; existing: number };
  listings: { created: number; existing: number };
  aliases: { created: number; collisions: number; takenByOtherUnit: number };
}

/**
 * Ghi danh mục vào tổ chức chỉ định. Không ghi đè bản ghi đã có (so theo mã); mọi bản ghi mới data_status = needs_confirmation.
 * Từ chối tổ chức DEMO để không trộn dữ liệu thật vào dữ liệu mẫu.
 */
export async function applyCatalog(orgSlug: string, catalog: CatalogParseResult): Promise<CatalogApplyResult> {
  return withTx(async (tx) => {
    const { rows: orgs } = await tx.query<{ id: string; is_demo: boolean; timezone: string }>("SELECT id, is_demo, timezone FROM organizations WHERE slug = $1", [orgSlug]);
    const org = orgs[0];
    if (!org) throw notFound(`tổ chức "${orgSlug}"`);
    if (org.is_demo) throw conflict("demo_org", "Tổ chức này là DEMO — không nhập danh mục thật vào dữ liệu mẫu.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7342))", [`catalog|${org.id}`]);
    const r: CatalogApplyResult = {
      properties: { created: 0, existing: 0 },
      resources: { created: 0, existing: 0 },
      units: { created: 0, existing: 0 },
      listings: { created: 0, existing: 0 },
      aliases: { created: 0, collisions: 0, takenByOtherUnit: 0 },
    };
    const idOf = async (table: "properties" | "resources" | "units", code: string) =>
      (await tx.query<{ id: string }>(`SELECT id FROM ${table} WHERE org_id = $1 AND code = $2`, [org.id, code])).rows[0]?.id ?? null;

    for (const h of catalog.houses) {
      let propertyId = await idOf("properties", h.code);
      if (propertyId) r.properties.existing += 1;
      else {
        propertyId = (
          await tx.query<{ id: string }>(
            "INSERT INTO properties (org_id, code, name, address, timezone, data_status, data_note) VALUES ($1,$2,$3,$4,$5,'needs_confirmation',$6) RETURNING id",
            [org.id, h.code, h.name, h.address, org.timezone, ["Nhập từ file Vietnam Team (docx)", ...h.confirmations].join(". ")],
          )
        ).rows[0].id;
        r.properties.created += 1;
      }
      const resourceIds = new Map<string, string>();
      for (const res of h.resources) {
        let id = await idOf("resources", res.code);
        if (id) r.resources.existing += 1;
        else {
          id = (await tx.query<{ id: string }>("INSERT INTO resources (org_id, property_id, code, name, kind) VALUES ($1,$2,$3,$4,$5) RETURNING id", [org.id, propertyId, res.code, res.name, res.kind])).rows[0].id;
          r.resources.created += 1;
        }
        resourceIds.set(res.code, id);
      }
      for (const [index, u] of h.units.entries()) {
        let unitId = await idOf("units", u.code);
        if (unitId) {
          r.units.existing += 1;
          continue; // không ghi đè sản phẩm đã có, kể cả listing
        }
        unitId = (
          await tx.query<{ id: string }>(
            `INSERT INTO units (org_id, property_id, code, name, kind, capacity, bed_config, data_status, data_note, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'needs_confirmation',$8,$9) RETURNING id`,
            [org.id, propertyId, u.code, u.name, u.kind, u.capacity, u.bedConfig, u.confirmations.join(". ") || null, index],
          )
        ).rows[0].id;
        r.units.created += 1;
        for (const rc of u.resourceCodes) {
          await tx.query("INSERT INTO unit_resources (unit_id, resource_id, org_id) VALUES ($1,$2,$3)", [unitId, resourceIds.get(rc), org.id]);
        }
        for (const l of u.listings) {
          await tx.query(
            `INSERT INTO channel_listings (org_id, unit_id, channel, account_label, listing_name, external_listing_id, capacity_on_channel, status, data_status, data_note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'needs_confirmation',$9)`,
            [org.id, unitId, l.channel, l.accountLabel, l.listingName, l.externalListingId, l.capacityOnChannel, l.status, l.note],
          );
          r.listings.created += 1;
        }
      }
    }
    const aliases = await createAliasesInTx(tx, org.id);
    r.aliases = { created: aliases.created.length, collisions: aliases.collisions.length, takenByOtherUnit: aliases.takenByOtherUnit.length };
    await writeAudit(tx, { orgId: org.id, actorType: "import", actorId: null }, "catalog.import_docx", "organization", org.id, { ...r });
    return r;
  });
}
