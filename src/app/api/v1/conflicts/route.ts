import { api } from "@/lib/http";
import { listConflicts } from "@/modules/booking/queries";

export const dynamic = "force-dynamic";

/** GET /api/v1/conflicts?status=open|resolved */
export const GET = api(async (req, actor) => {
  const status = new URL(req.url).searchParams.get("status");
  return { items: await listConflicts(actor, { status: status || null }) };
});
