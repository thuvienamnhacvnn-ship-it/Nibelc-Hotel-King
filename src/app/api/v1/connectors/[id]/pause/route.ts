import { api, readJson } from "@/lib/http";
import { setConnectorPaused } from "@/modules/connectors/queries";

/** POST /api/v1/connectors/:id/pause { paused: boolean, reason? } — lý do bắt buộc khi tạm dừng. Quyền connector.manage hoặc automation.pause. */
export const POST = api<{ id: string }>(async (req, actor, { id }) => setConnectorPaused(actor, id, await readJson(req)));
