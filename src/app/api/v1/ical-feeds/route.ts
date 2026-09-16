import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { addIcalFeed, listFeeds } from "@/modules/icalsync/service";

const body = z.object({ listingId: z.string().uuid(), url: z.string().min(10).max(2000) });

export const GET = api(async (_req, actor) => ({ items: await listFeeds(actor) }));

export const POST = api(async (req, actor) => addIcalFeed(actor, body.parse(await readJson(req))));
