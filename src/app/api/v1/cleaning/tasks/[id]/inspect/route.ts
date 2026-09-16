import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { inspectTask } from "@/modules/cleaning/service";

const Body = z.object({
  result: z.enum(["pass", "fail"], "Chọn kết quả kiểm: đạt hoặc cần dọn lại."),
  note: z.string().max(2000).nullish(),
  expectedVersion: z.number().int().optional(),
});

export const POST = api<{ id: string }>(async (req, actor, { id }) => inspectTask(actor, id, Body.parse(await readJson(req))));
