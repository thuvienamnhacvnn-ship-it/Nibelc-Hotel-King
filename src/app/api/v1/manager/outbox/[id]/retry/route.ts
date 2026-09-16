import { api } from "@/lib/http";
import { retryOutboxEvent } from "@/modules/manager/service";

/** POST /api/v1/manager/outbox/:id/retry — đặt lại sự kiện dead/pending thành pending (admin/leader), giữ số lần thử, có audit. */
export const POST = api<{ id: string }>(async (_req, actor, { id }) => retryOutboxEvent(actor, id));
