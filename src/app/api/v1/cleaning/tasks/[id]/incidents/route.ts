import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { reportIncident } from "@/modules/cleaning/service";

const Body = z.object({
  kind: z.enum(["maintenance", "missing_supplies", "damage", "guest_still_inside", "access", "other"], "Chọn loại sự cố."),
  severity: z.enum(["low", "normal", "blocking"], "Chọn mức độ."),
  description: z.string().max(2000).default(""),
});

export const POST = api<{ id: string }>(async (req, actor, { id }) => reportIncident(actor, id, Body.parse(await readJson(req))));
