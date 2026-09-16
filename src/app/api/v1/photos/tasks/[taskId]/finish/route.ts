import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { finishWithEvidence } from "@/modules/photos/qc";

const Body = z.object({ expectedVersion: z.number().int().optional(), note: z.string().max(2000).nullish() });

/** Báo hoàn thành có kiểm ảnh bắt buộc ở máy chủ, rồi chuyển cho finishTask của module cleaning. */
export const POST = api<{ taskId: string }>(async (req, actor, { taskId }) => finishWithEvidence(actor, taskId, Body.parse(await readJson(req))));
