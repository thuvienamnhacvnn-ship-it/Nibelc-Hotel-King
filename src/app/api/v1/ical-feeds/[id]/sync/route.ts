import { api } from "@/lib/http";
import { syncFeedNow } from "@/modules/icalsync/service";

export const POST = api<{ id: string }>(async (_req, actor, params) => syncFeedNow(actor, params.id));
