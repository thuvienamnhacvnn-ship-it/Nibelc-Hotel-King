import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { declineTask } from "@/modules/cleaning/service";

const Body = z.object({ reason: z.string().default(""), expectedVersion: z.number().int().optional() });

export const POST = api<{ id: string }>(async (req, actor, { id }) => {
  const body = Body.parse(await readJson(req));
  return declineTask(actor, id, body.reason, body.expectedVersion);
});
