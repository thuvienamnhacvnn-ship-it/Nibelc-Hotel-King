import { type Queryable, pool, withTx } from "@/lib/db";
import { writeAudit, auditActorOf } from "@/modules/audit/audit";
import { type Actor, assertCan } from "@/modules/auth/actor";
import { normalizeUnitAlias } from "./excel/normalize";
import type { UnitLookup, UnitLookupEntry } from "./excel/parser";

/**
 * Alias tên căn/phòng. Tên sản phẩm trong danh mục ("Baby Room Jozsef 50") sinh ra alias chuẩn hoá;
 * Excel viết "Baby Room J50" sẽ ra cùng khoá. Nguyên căn thêm alias "<tên> apartment" vì Excel hay ghi "Baross Flat".
 */
export function aliasCandidatesForUnit(unit: { code: string; name: string; kind: string | null }): string[] {
  const out = new Set<string>();
  const byName = normalizeUnitAlias(unit.name);
  if (byName) out.add(byName);
  if (unit.kind === "whole" && !/\b(apartment|studio)\b/.test(byName)) out.add(normalizeUnitAlias(`${unit.name} apartment`));
  out.delete(normalizeUnitAlias(unit.code));
  return [...out];
}

interface LookupUnit extends UnitLookupEntry {
  aliases?: string[];
}

/**
 * Dựng bảng tra từ danh sách sản phẩm. Mã sản phẩm luôn thắng alias. Hai sản phẩm khác nhau cùng sinh một alias
 * ⇒ alias đó bị bỏ (mơ hồ) và báo trong `collisions`.
 */
export function buildLookup(units: LookupUnit[], opts: { fromNames: boolean }): { lookup: UnitLookup; collisions: { alias: string; codes: string[] }[] } {
  const lookup: UnitLookup = new Map();
  for (const u of units) lookup.set(normalizeUnitAlias(u.code), u);
  const claims = new Map<string, Set<string>>();
  const entries = new Map<string, LookupUnit>();
  for (const u of units) {
    const aliases = [...(u.aliases ?? []), ...(opts.fromNames ? aliasCandidatesForUnit(u) : [])];
    for (const a of new Set(aliases)) {
      if (!a || lookup.has(a)) continue;
      const set = claims.get(a) ?? new Set<string>();
      set.add(u.code);
      claims.set(a, set);
      entries.set(a, u);
    }
  }
  const collisions: { alias: string; codes: string[] }[] = [];
  for (const [alias, codes] of claims) {
    if (codes.size > 1) collisions.push({ alias, codes: [...codes].sort() });
    else lookup.set(alias, entries.get(alias)!);
  }
  return { lookup, collisions };
}

/** Bảng tra theo DB của tổ chức: mã sản phẩm + bảng unit_aliases. */
export async function loadUnitLookup(orgId: string, q: Queryable = pool()): Promise<UnitLookup> {
  const units = await q.query<{ id: string; code: string; name: string; kind: string; capacity: number }>(
    "SELECT id, code, name, kind, capacity FROM units WHERE org_id = $1",
    [orgId],
  );
  const aliases = await q.query<{ unit_id: string; alias_norm: string; alias_raw: string }>(
    "SELECT unit_id, alias_norm, alias_raw FROM unit_aliases WHERE org_id = $1",
    [orgId],
  );
  const byId = new Map<string, LookupUnit>();
  for (const u of units.rows) byId.set(u.id, { unitId: u.id, code: u.code, name: u.name, kind: u.kind, capacity: u.capacity, aliases: [] });
  for (const a of aliases.rows) {
    const u = byId.get(a.unit_id);
    if (!u) continue;
    u.aliases!.push(a.alias_norm, normalizeUnitAlias(a.alias_raw));
  }
  return buildLookup([...byId.values()], { fromNames: false }).lookup;
}

export interface AliasCreationResult {
  created: { code: string; alias: string }[];
  existing: number;
  collisions: { alias: string; codes: string[] }[];
  takenByOtherUnit: { alias: string; code: string; takenBy: string }[];
}

/**
 * Tạo alias từ tên nội bộ của mọi sản phẩm trong tổ chức (nguồn 'unit_name').
 * Kiểm trước rồi mới ghi (bẫy PGlite): alias đã trỏ sản phẩm khác thì bỏ qua và báo, không ghi đè.
 */
export async function createAliasesFromUnitNames(actor: Actor): Promise<AliasCreationResult> {
  assertCan(actor, "catalog.edit");
  return withTx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7341))", [`aliases|${actor.orgId}`]);
    const result = await createAliasesInTx(tx, actor.orgId);
    await writeAudit(tx, auditActorOf(actor), "catalog.aliases_from_names", "organization", actor.orgId, {
      created: result.created.length,
      collisions: result.collisions.length,
      takenByOtherUnit: result.takenByOtherUnit.length,
    });
    return result;
  });
}

export async function createAliasesInTx(tx: Queryable, orgId: string): Promise<AliasCreationResult> {
  const { rows: units } = await tx.query<{ id: string; code: string; name: string; kind: string; capacity: number }>(
    "SELECT id, code, name, kind, capacity FROM units WHERE org_id = $1 ORDER BY code",
    [orgId],
  );
  const { rows: existingRows } = await tx.query<{ alias_norm: string; unit_id: string }>("SELECT alias_norm, unit_id FROM unit_aliases WHERE org_id = $1", [orgId]);
  const existing = new Map(existingRows.map((r) => [r.alias_norm, r.unit_id]));
  const codeById = new Map(units.map((u) => [u.id, u.code]));
  const codeKeys = new Set(units.map((u) => normalizeUnitAlias(u.code)));

  const claims = new Map<string, { id: string; code: string; raw: string }[]>();
  for (const u of units) {
    for (const alias of aliasCandidatesForUnit(u)) {
      if (codeKeys.has(alias)) continue;
      const list = claims.get(alias) ?? [];
      list.push({ id: u.id, code: u.code, raw: u.name });
      claims.set(alias, list);
    }
  }
  const result: AliasCreationResult = { created: [], existing: 0, collisions: [], takenByOtherUnit: [] };
  for (const [alias, list] of claims) {
    const distinct = [...new Set(list.map((l) => l.id))];
    if (distinct.length > 1) {
      result.collisions.push({ alias, codes: list.map((l) => l.code).sort() });
      continue;
    }
    const owner = list[0];
    const taken = existing.get(alias);
    if (taken === owner.id) {
      result.existing += 1;
      continue;
    }
    if (taken) {
      result.takenByOtherUnit.push({ alias, code: owner.code, takenBy: codeById.get(taken) ?? "?" });
      continue;
    }
    await tx.query("INSERT INTO unit_aliases (org_id, unit_id, alias_norm, alias_raw, source) VALUES ($1,$2,$3,$4,'unit_name')", [orgId, owner.id, alias, owner.raw]);
    existing.set(alias, owner.id);
    result.created.push({ code: owner.code, alias });
  }
  return result;
}
