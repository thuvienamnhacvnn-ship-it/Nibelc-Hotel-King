import { forbidden } from "@/lib/errors";
import { api, readJson } from "@/lib/http";
import { can } from "@/modules/auth/actor";
import { listEscalationContacts } from "@/modules/manager/queries";
import { addEscalationContact } from "@/modules/manager/service";

/** GET /api/v1/manager/escalation-contacts — người trực theo mục đích + cấp. */
export const GET = api(async (_req, actor) => {
  if (!can(actor, "automation.pause") && !can(actor, "reports.view")) throw forbidden();
  const items = await listEscalationContacts(actor);
  return { items, page: 1, pageSize: items.length, total: items.length };
});

/** POST /api/v1/manager/escalation-contacts { purpose, level, userId } — quyền automation.pause. */
export const POST = api(async (req, actor) => addEscalationContact(actor, await readJson(req)));
