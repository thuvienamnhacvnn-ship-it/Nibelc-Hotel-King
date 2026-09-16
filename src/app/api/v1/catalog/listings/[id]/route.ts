import { api, readJson } from "@/lib/http";
import { updateListing } from "@/modules/catalog/service";

/** PATCH /api/v1/catalog/listings/:id { expectedUpdatedAt?, status?, dataStatus?, dataNote? } */
export const PATCH = api<{ id: string }>(async (req, actor, { id }) => updateListing(actor, id, await readJson(req)));
