import { api, readJson } from "@/lib/http";
import { removeReportSubscription, updateReportSubscription } from "@/modules/manager/service";

/** PATCH /api/v1/manager/subscriptions/:id { enabled?, sendTime?, reason? } — bật cần lý do. */
export const PATCH = api<{ id: string }>(async (req, actor, { id }) => updateReportSubscription(actor, id, await readJson(req)));

/** DELETE /api/v1/manager/subscriptions/:id */
export const DELETE = api<{ id: string }>(async (_req, actor, { id }) => removeReportSubscription(actor, id));
