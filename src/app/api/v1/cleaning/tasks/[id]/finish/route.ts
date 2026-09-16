import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { finishTask } from "@/modules/cleaning/service";

const Body = z.object({ expectedVersion: z.number().int().optional(), note: z.string().max(2000).nullish() });

export const POST = api<{ id: string }>(async (req, actor, { id }) => finishTask(actor, id, Body.parse(await readJson(req))));
