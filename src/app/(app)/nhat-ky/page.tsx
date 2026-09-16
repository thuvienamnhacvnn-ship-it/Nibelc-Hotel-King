import Link from "next/link";
import { Card, EmptyState, PageHeader, Pagination } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { formatInstant, now, tzAbbrev } from "@/lib/time";
import { auditFilterOptions, listAudit } from "@/modules/audit/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nhật ký" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const KEYS = ["entityType", "action", "actor", "from", "to"] as const;

const ACTOR_TYPE_LABELS: Record<string, string> = { user: "Người dùng", system: "Hệ thống", connector: "Connector", import: "Nhập Excel", agent: "Agent" };

export default async function AuditPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("audit.view");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const filter = Object.fromEntries(KEYS.map((k) => [k, str(k)])) as Record<(typeof KEYS)[number], string | null>;
  const page = Math.max(1, Number(str("page")) || 1);
  const pageSize = 50;
  const [data, options] = await Promise.all([listAudit(actor, filter, { page, pageSize, offset: (page - 1) * pageSize }), auditFilterOptions(actor)]);
  const filtered = KEYS.some((k) => filter[k]);

  const hrefFor = (p: number) => {
    const q = new URLSearchParams();
    for (const k of KEYS) if (filter[k]) q.set(k, filter[k]!);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return `/nhat-ky${s ? `?${s}` : ""}`;
  };

  return (
    <div className="stack">
      <PageHeader title="Nhật ký" description={`Ai đã làm gì, lúc nào. Giờ hiển thị theo Budapest (${tzAbbrev(now(), actor.timezone)}); khoảng ngày lọc cũng theo giờ Budapest.`} />

      <Card pad={false}>
        <form method="get" action="/nhat-ky" className="card-pad grid grid-3" style={{ gap: 10, alignItems: "end" }}>
          <div className="field">
            <label htmlFor="f-entity">Loại đối tượng</label>
            <select id="f-entity" name="entityType" className="select" defaultValue={filter.entityType ?? ""}>
              <option value="">Tất cả</option>
              {options.entityTypes.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-action">Hành động</label>
            <select id="f-action" name="action" className="select" defaultValue={filter.action ?? ""}>
              <option value="">Tất cả</option>
              {options.actions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-actor">Người thực hiện</label>
            <select id="f-actor" name="actor" className="select" defaultValue={filter.actor ?? ""}>
              <option value="">Tất cả</option>
              {options.actors.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-from">Từ ngày</label>
            <input id="f-from" type="date" name="from" className="input" defaultValue={filter.from ?? ""} />
          </div>
          <div className="field">
            <label htmlFor="f-to">Đến hết ngày</label>
            <input id="f-to" type="date" name="to" className="input" defaultValue={filter.to ?? ""} />
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary">
              Lọc
            </button>
            {filtered ? (
              <Link href="/nhat-ky" className="btn">
                Bỏ lọc
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card title={`Bản ghi (${data.total})`} pad={false}>
        {data.items.length === 0 ? (
          <EmptyState title={filtered ? "Không có bản ghi khớp bộ lọc" : "Nhật ký trống"} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Thời điểm</th>
                  <th>Người thực hiện</th>
                  <th>Hành động</th>
                  <th>Đối tượng</th>
                  <th>Chi tiết</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>
                      {formatInstant(r.created_at, actor.timezone)}
                    </td>
                    <td className="small">
                      {r.actor_name ?? ACTOR_TYPE_LABELS[r.actor_type] ?? r.actor_type}
                      {r.actor_name ? null : r.actor_id ? <div className="mono faint">{r.actor_id.slice(0, 8)}</div> : null}
                      {r.ip ? <div className="faint">IP {r.ip}</div> : null}
                    </td>
                    <td className="mono">{r.action}</td>
                    <td className="small">
                      <div>{r.entity_type}</div>
                      {r.entity_id ? (
                        r.entity_type === "booking" ? (
                          <Link className="mono" href={`/bookings/${r.entity_id}`}>
                            {r.entity_id.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="mono faint" title={r.entity_id}>
                            {r.entity_id.length > 12 ? `${r.entity_id.slice(0, 8)}…` : r.entity_id}
                          </span>
                        )
                      ) : null}
                    </td>
                    <td style={{ maxWidth: 520 }}>
                      {r.detail == null ? (
                        <span className="faint">—</span>
                      ) : (
                        <details>
                          <summary className="small" style={{ cursor: "pointer" }}>
                            {summarize(r.detail)}
                          </summary>
                          <pre className="mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "6px 0 0", fontSize: 12, background: "var(--surface-muted)", padding: 8, borderRadius: 6 }}>
                            {JSON.stringify(r.detail, null, 2)}
                          </pre>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad">
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={hrefFor} />
        </div>
      </Card>
    </div>
  );
}

function summarize(detail: unknown) {
  if (!detail || typeof detail !== "object") return String(detail);
  const keys = Object.keys(detail as Record<string, unknown>);
  if (keys.length === 0) return "(trống)";
  return `${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ` +${keys.length - 4}` : ""}`;
}
