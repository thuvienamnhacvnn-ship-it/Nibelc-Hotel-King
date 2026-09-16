import { api, pageParams, readJson } from "@/lib/http";
import { listQaEntries, parseQaFilters } from "@/modules/qa/queries";
import { createQaDraft } from "@/modules/qa/service";

/** GET /api/v1/qa?scope&property&unit&status(draft|pending_review|approved|retired|all)&topic&q&page&pageSize — mặc định ẩn bản đã ngưng. */
export const GET = api(async (req, actor) => {
  const url = new URL(req.url);
  return listQaEntries(actor, parseQaFilters(url.searchParams), pageParams(url));
});

/** POST /api/v1/qa { scope, propertyId?, unitId?, topic, question, variants[], answerEn, answerVi?, sensitivity, handoffCondition?, source?, validFrom?, validTo? } → bản nháp v1 */
export const POST = api(async (req, actor) => createQaDraft(actor, await readJson(req)));
