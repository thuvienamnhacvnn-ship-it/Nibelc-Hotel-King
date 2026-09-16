import { api } from "@/lib/http";
import { removeIcalFeed } from "@/modules/icalsync/service";

export const DELETE = api<{ id: string }>(async (_req, actor, params) => removeIcalFeed(actor, params.id));
