import { api } from "@/lib/http";
import { getTaskEvidence } from "@/modules/photos/queries";

export const GET = api<{ taskId: string }>(async (_req, actor, { taskId }) => getTaskEvidence(actor, taskId));
