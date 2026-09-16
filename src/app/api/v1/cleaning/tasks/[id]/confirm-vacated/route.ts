import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { confirmVacated } from "@/modules/cleaning/service";

const Body = z.object({ note: z.string().default("") });

export const POST = api<{ id: string }>(async (req, actor, { id }) => confirmVacated(actor, id, Body.parse(await readJson(req)).note));
