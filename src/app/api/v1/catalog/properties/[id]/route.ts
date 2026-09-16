import { api, readJson } from "@/lib/http";
import { updateProperty } from "@/modules/catalog/service";

/** PATCH /api/v1/catalog/properties/:id { expectedUpdatedAt?, dataStatus?, dataNote?, defaultCleanMinutes? } */
export const PATCH = api<{ id: string }>(async (req, actor, { id }) => updateProperty(actor, id, await readJson(req)));
