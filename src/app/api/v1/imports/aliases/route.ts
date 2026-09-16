import { api } from "@/lib/http";
import { createAliasesFromUnitNames } from "@/modules/imports/aliases";

export const dynamic = "force-dynamic";

/** POST → tạo alias từ tên nội bộ của mọi sản phẩm (quyền catalog.edit). Không ghi đè alias đang trỏ sản phẩm khác. */
export const POST = api(async (_req, actor) => createAliasesFromUnitNames(actor));
