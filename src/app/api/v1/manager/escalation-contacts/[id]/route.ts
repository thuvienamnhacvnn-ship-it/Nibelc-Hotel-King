import { api, readJson } from "@/lib/http";
import { removeEscalationContact, updateEscalationContact } from "@/modules/manager/service";

/** PATCH /api/v1/manager/escalation-contacts/:id { level?, active? } */
export const PATCH = api<{ id: string }>(async (req, actor, { id }) => updateEscalationContact(actor, id, await readJson(req)));

/** DELETE /api/v1/manager/escalation-contacts/:id */
export const DELETE = api<{ id: string }>(async (_req, actor, { id }) => removeEscalationContact(actor, id));
