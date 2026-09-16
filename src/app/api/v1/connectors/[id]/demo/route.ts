import { api, readJson } from "@/lib/http";
import { runDemoScenario } from "@/modules/connectors/demo-feed";

/**
 * POST /api/v1/connectors/:id/demo { scenario: new|resend|stale|dates|cancel|conflict, externalRef? }
 * Chỉ connector status='demo'. Trả { demo: true, scenario, event, result: { status, inboundEventId, bookingId, message }, booking }.
 */
export const POST = api<{ id: string }>(async (req, actor, { id }) => runDemoScenario(actor, id, await readJson(req)));
