import { forbidden } from "@/lib/errors";
import { api, readJson } from "@/lib/http";
import { can } from "@/modules/auth/actor";
import { listTemplates } from "@/modules/manager/queries";
import { saveTemplateDraft } from "@/modules/manager/service";

/** GET /api/v1/manager/templates — mẫu tin cho đội. */
export const GET = api(async (_req, actor) => {
  if (!can(actor, "automation.pause") && !can(actor, "reports.view") && !can(actor, "templates.approve")) throw forbidden();
  const items = await listTemplates(actor);
  return { items, page: 1, pageSize: items.length, total: items.length };
});

/** POST /api/v1/manager/templates { key, language, body } — tạo/sửa, luôn về nháp (sửa mẫu đã duyệt phải duyệt lại). */
export const POST = api(async (req, actor) => saveTemplateDraft(actor, await readJson(req)));
