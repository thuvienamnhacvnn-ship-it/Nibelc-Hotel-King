import { api, assertUuid, readJson } from "@/lib/http";
import { updateUnit } from "@/modules/catalog/service";

/** PATCH /api/v1/catalog/units/:id { expectedUpdatedAt?, dataStatus?, dataNote?, capacity?, active?, cleanMinutes? } */
export const PATCH = api<{ id: string }>(async (req, actor, { id }) => updateUnit(actor, assertUuid(id), await readJson(req)));
