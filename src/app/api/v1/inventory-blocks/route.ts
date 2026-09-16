import { z } from "zod";
import { api, readJson } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { createInventoryBlock } from "@/modules/booking/service";
import { dateString } from "@/modules/booking/types";
import { listActiveBlocks } from "@/modules/calendar/queries";

const createInput = z
  .object({
    unitId: z.string().uuid("Chọn phòng/sản phẩm"),
    startDate: dateString,
    endDate: dateString,
    reason: z.string().trim().min(3, "Cần lý do chặn (ít nhất 3 ký tự)").max(500),
  })
  .refine((v) => v.endDate > v.startDate, { message: "Ngày kết thúc phải sau ngày bắt đầu", path: ["endDate"] });

/** GET /api/v1/inventory-blocks?from=YYYY-MM-DD&unitId= — chặn tồn đang hiệu lực. */
export const GET = api(async (req, actor) => {
  assertCan(actor, "calendar.view");
  const url = new URL(req.url);
  const items = await listActiveBlocks(actor, { from: url.searchParams.get("from"), unitId: url.searchParams.get("unitId") });
  return { items, page: 1, pageSize: items.length, total: items.length };
});

/** POST /api/v1/inventory-blocks { unitId, startDate, endDate, reason } — 409 inventory_conflict kèm details.conflicts. */
export const POST = api(async (req, actor) => {
  assertCan(actor, "inventory.block");
  const input = createInput.parse(await readJson(req));
  return createInventoryBlock(actor, input);
});
