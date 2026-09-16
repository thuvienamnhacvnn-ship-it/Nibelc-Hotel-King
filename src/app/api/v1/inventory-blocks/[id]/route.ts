import { api, assertUuid } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { releaseInventoryBlock } from "@/modules/booking/service";

/** DELETE /api/v1/inventory-blocks/:id — gỡ chặn tồn (giải phóng tài nguyên, ghi audit inventory.unblock). */
export const DELETE = api<{ id: string }>(async (_req, actor, { id }) => {
  assertCan(actor, "inventory.block");
  return releaseInventoryBlock(actor, assertUuid(id, "chặn tồn"));
});
