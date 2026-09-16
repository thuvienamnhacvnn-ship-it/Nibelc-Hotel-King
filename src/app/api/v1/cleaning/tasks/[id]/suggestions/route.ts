import { api } from "@/lib/http";
import { suggestCleaners } from "@/modules/cleaning/service";

/** GET /api/v1/cleaning/tasks/:id/suggestions — gợi ý cleaner (điểm + lý do). Không tự giao. */
export const GET = api<{ id: string }>(async (_req, actor, { id }) => {
  const items = await suggestCleaners(actor, id);
  return { items, covered: items.some((s) => s.hasShift && s.tasksThatDay < s.maxTasks) };
});
