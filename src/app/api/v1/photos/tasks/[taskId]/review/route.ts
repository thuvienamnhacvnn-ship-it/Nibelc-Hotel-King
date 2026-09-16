import { api } from "@/lib/http";
import { reviewTask } from "@/modules/photos/qc";

/** Chạy lại kiểm luật + AI. Chỉ ghi qc_reviews, không đổi trạng thái việc. */
export const POST = api<{ taskId: string }>(async (_req, actor, { taskId }) => reviewTask(actor, taskId));
