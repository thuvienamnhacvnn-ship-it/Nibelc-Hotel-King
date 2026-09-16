import { notFound } from "@/lib/errors";
import { api, assertUuid, readJson } from "@/lib/http";
import { qaEntryHistory } from "@/modules/qa/queries";
import { updateQaDraft } from "@/modules/qa/service";

/** GET /api/v1/qa/:id — mọi phiên bản cùng câu hỏi (mới nhất trước) + nhật ký thay đổi. */
export const GET = api<{ id: string }>(async (_req, actor, { id }) => {
  const history = await qaEntryHistory(actor, assertUuid(id));
  if (!history) throw notFound("mục Q&A");
  return history;
});

/** PATCH /api/v1/qa/:id { expectedUpdatedAt?, content } — chỉ bản nháp/chờ duyệt (chờ duyệt bị sửa quay về nháp). */
export const PATCH = api<{ id: string }>(async (req, actor, { id }) => updateQaDraft(actor, assertUuid(id), await readJson(req)));
