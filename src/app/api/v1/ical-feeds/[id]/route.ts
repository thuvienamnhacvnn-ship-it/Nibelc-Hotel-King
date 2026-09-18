import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { removeIcalFeed, setIcalHoldMode } from "@/modules/icalsync/service";

const body = z.object({ holdMode: z.enum(["off", "block"]) });

export const PATCH = api<{ id: string }>(async (req, actor, params) => setIcalHoldMode(actor, params.id, body.parse(await readJson(req)).holdMode));

export const DELETE = api<{ id: string }>(async (_req, actor, params) => removeIcalFeed(actor, params.id));
