import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { assignTask } from "@/modules/cleaning/service";

const Body = z.object({ userId: z.uuid("Chọn cleaner."), expectedVersion: z.number().int().optional() });

export const POST = api<{ id: string }>(async (req, actor, { id }) => assignTask(actor, id, Body.parse(await readJson(req))));
