import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { toggleChecklistItem } from "@/modules/cleaning/service";

const Body = z.object({ checked: z.boolean("Thiếu trạng thái checked."), note: z.string().max(1000).nullish() });

export const PATCH = api<{ id: string; itemId: string }>(async (req, actor, { id, itemId }) => toggleChecklistItem(actor, id, itemId, Body.parse(await readJson(req))));
