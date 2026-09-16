import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { resolveIncident } from "@/modules/cleaning/service";

const Body = z.object({ note: z.string().trim().min(1, "Ghi ngắn đã xử lý thế nào.").max(2000) });

export const POST = api<{ id: string }>(async (req, actor, { id }) => resolveIncident(actor, id, Body.parse(await readJson(req)).note));
