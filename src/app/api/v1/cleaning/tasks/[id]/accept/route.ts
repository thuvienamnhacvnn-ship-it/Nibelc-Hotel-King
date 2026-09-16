import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { acceptTask } from "@/modules/cleaning/service";

const Body = z.object({ expectedVersion: z.number().int().optional() });

export const POST = api<{ id: string }>(async (req, actor, { id }) => acceptTask(actor, id, Body.parse(await readJson(req)).expectedVersion));
