import { notFound } from "@/lib/errors";
import { api } from "@/lib/http";
import { assertCan } from "@/modules/auth/actor";
import { getReport } from "@/modules/manager/queries";
import { reportWhatsAppPreview } from "@/modules/manager/report";

/** GET /api/v1/manager/reports/:id — số liệu, diễn giải, bản xem trước tin WhatsApp. */
export const GET = api<{ id: string }>(async (_req, actor, { id }) => {
  assertCan(actor, "reports.view");
  const report = await getReport(actor, id);
  if (!report) throw notFound("báo cáo");
  return { ...report, whatsappPreview: reportWhatsAppPreview(report.data) };
});
