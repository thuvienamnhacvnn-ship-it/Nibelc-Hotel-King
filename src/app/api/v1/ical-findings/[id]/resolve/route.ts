import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { resolveFinding } from "@/modules/icalsync/service";

const body = z.object({ status: z.enum(["resolved", "dismissed"]), note: z.string().max(500) });

export const POST = api<{ id: string }>(async (req, actor, params) => resolveFinding(actor, params.id, body.parse(await readJson(req))));
