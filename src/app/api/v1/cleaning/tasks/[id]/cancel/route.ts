import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { cancelTask } from "@/modules/cleaning/service";

const Body = z.object({ reason: z.string().default("") });

export const POST = api<{ id: string }>(async (req, actor, { id }) => cancelTask(actor, id, Body.parse(await readJson(req)).reason));
