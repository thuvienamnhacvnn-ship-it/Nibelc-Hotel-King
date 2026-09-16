import { z } from "zod";
import { notFound } from "@/lib/errors";
import { api } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { releaseInventoryBlock } from "@/modules/booking/service";

/** DELETE /api/v1/inventory-blocks/:id — gỡ chặn tồn (giải phóng tài nguyên, ghi audit inventory.unblock). */
export const DELETE = api<{ id: string }>(async (_req, actor, { id }) => {
  assertCan(actor, "inventory.block");
  // Kiểm trước: id sai định dạng sẽ làm câu lệnh lỗi trong giao dịch (bẫy PGlite).
  if (!z.string().uuid().safeParse(id).success) throw notFound("chặn tồn");
  return releaseInventoryBlock(actor, id);
});
