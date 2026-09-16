import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, DemoBadge, EmptyState, KeyValue, Notice, PageHeader, Pagination, Stat } from "@/components/ui";
import { pageParams } from "@/lib/http";
import { requireActor } from "@/lib/session";
import { formatDateVi, formatInstant, todayOps } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANNEL_LABELS } from "@/modules/booking/types";
import { DISPOSITIONS, DISPOSITION_LABELS, ISSUE_DEFS, ISSUE_LABELS } from "@/modules/imports/excel/issues";
import { getImportBatch, importCatalogOverview, listImportRows } from "@/modules/imports/queries";
import { ApplyPanel } from "../_components/apply-panel";
import { DiscardBatchButton } from "../_components/small-actions";
import { BATCH_STATUS_LABELS, batchTone, dispositionTone } from "../labels";
import styles from "../nhap-excel.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lô nhập Excel" };

interface SheetStat {
  name: string;
  role: "source" | "house" | "cancel" | "other";
  headerRow: number | null;
  dataRows: number;
  reconciliation?: { withRef: number; noRef: number; matched: number; mismatched: number; onlyInHouse: number };
}

const ROLE_LABELS: Record<string, string> = { source: "Sheet nguồn", house: "Sheet nhà (đối chiếu)", cancel: "Sheet Hủy (kiểm tra)", other: "Không có bảng booking" };

export default async function BatchPage({ params, searchParams }: { params: Promise<{ batchId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireActor("import.preview");
  const { batchId } = await params;
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const batch = await getImportBatch(actor, batchId);
  if (!batch) notFound();

  const filter = { disposition: str("disposition"), issue: str("issue"), sheet: str("sheet") };
  const page = pageParams(new URL(`http://local/?page=${str("page") ?? "1"}&pageSize=50`));
  const [rows, overview] = await Promise.all([listImportRows(actor, batch.id, filter, page), importCatalogOverview(actor)]);

  const stats = batch.stats as {
    total?: number;
    byDisposition?: Record<string, number>;
    byIssue?: Record<string, number>;
    sheets?: SheetStat[];
    apply?: { applied: number; alreadyImported: number; errors: number; skipped: number; finishedAt: string; skipCheckOutBefore: string | null };
  };
  const byD = stats.byDisposition ?? {};
  const byI = stats.byIssue ?? {};
  const ready = byD.ready ?? 0;
  const today = todayOps(actor.timezone);
  const qs = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams();
    const merged = { ...filter, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    const s = u.toString();
    return `/nhap-excel/${batch.id}${s ? `?${s}` : ""}`;
  };
  const showGuest = can(actor, "booking.view_guest_contact");

  return (
    <div className="stack">
      <PageHeader
        title={
          <>
            {batch.file_name} <DemoBadge show={overview.orgIsDemo} />
          </>
        }
        description={`Lô nhập từ sheet ${String(batch.options.sourceSheet ?? "TH")}. Giá trị gốc được giữ nguyên theo sheet và số dòng Excel.`}
        actions={
          <Link className="btn" href="/nhap-excel">
            ← Các lô
          </Link>
        }
      />

      <Card>
        <KeyValue
          items={[
            ["Trạng thái", <Badge key="s" tone={batchTone(batch.status)}>{BATCH_STATUS_LABELS[batch.status]}</Badge>],
            ["Tạo lúc", `${formatInstant(batch.created_at, actor.timezone)}${batch.created_by_name ? ` · ${batch.created_by_name}` : ""}`],
            ["Áp dụng lúc", batch.applied_at ? `${formatInstant(batch.applied_at, actor.timezone)}${batch.applied_by_name ? ` · ${batch.applied_by_name}` : ""}` : "—"],
            ["SHA-256", <span key="h" className="mono small">{batch.file_sha256}</span>],
            ["Tổng dòng trong lô", String(stats.total ?? 0)],
          ]}
        />
      </Card>

      {stats.apply ? (
        <Notice tone={stats.apply.errors ? "warn" : "info"} title="Kết quả áp dụng gần nhất">
          Tạo {stats.apply.applied} booking · đã có sẵn {stats.apply.alreadyImported} · lỗi {stats.apply.errors} · không áp dụng {stats.apply.skipped}
          {stats.apply.skipCheckOutBefore ? ` (bỏ qua kỳ ở trả phòng trước ${formatDateVi(stats.apply.skipCheckOutBefore)})` : ""} — lúc {formatInstant(stats.apply.finishedAt, actor.timezone)}.
        </Notice>
      ) : null}

      <div className="grid grid-4">
        {DISPOSITIONS.map((d) => (
          <Stat key={d} label={DISPOSITION_LABELS[d]} value={byD[d] ?? 0} href={qs({ disposition: d, issue: null, page: null })} tone={d === "error" && byD[d] ? "danger" : d === "needs_review" && byD[d] ? "warn" : undefined} />
        ))}
      </div>

      {batch.status !== "discarded" && (ready > 0 || batch.status === "previewed") ? (
        <Card title="2. Áp dụng">
          {can(actor, "import.apply") ? (
            <div className="stack">
              <ApplyPanel batchId={batch.id} readyCount={ready} today={today} todayLabel={formatDateVi(today)} />
              {batch.status === "previewed" ? <DiscardBatchButton batchId={batch.id} /> : null}
            </div>
          ) : (
            <p className="small">Bạn chỉ có quyền xem trước. Người có quyền áp dụng nhập Excel sẽ áp dụng lô này.</p>
          )}
        </Card>
      ) : null}

      <div className="grid grid-2">
        <Card title="Lý do cần kiểm tra" pad={false}>
          {Object.keys(byI).length === 0 ? (
            <EmptyState title="Không có dòng nào cần lưu ý" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Lý do</th>
                    <th>Mức</th>
                    <th>Số dòng</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(byI)
                    .sort((a, b) => b[1] - a[1])
                    .map(([code, n]) => (
                      <tr key={code}>
                        <td>
                          <Link href={qs({ issue: code, disposition: null, page: null })}>{ISSUE_LABELS[code] ?? code}</Link>
                          <div className="small faint mono">{code}</div>
                        </td>
                        <td>{Object.hasOwn(ISSUE_DEFS, code) && ISSUE_DEFS[code as keyof typeof ISSUE_DEFS].severity === "block" ? <Badge tone="warn">Chặn áp dụng</Badge> : <Badge>Cảnh báo</Badge>}</td>
                        <td>{n}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Sheet trong file" pad={false}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sheet</th>
                  <th>Vai trò</th>
                  <th>Dòng</th>
                  <th>Đối chiếu với sheet nguồn</th>
                </tr>
              </thead>
              <tbody>
                {(stats.sheets ?? []).map((s) => (
                  <tr key={s.name}>
                    <td className="strong">{s.name}</td>
                    <td className="small">{ROLE_LABELS[s.role]}</td>
                    <td>{s.headerRow ? s.dataRows : "—"}</td>
                    <td className="small">
                      {s.reconciliation
                        ? `khớp ${s.reconciliation.matched} · lệch ngày ${s.reconciliation.mismatched} · chỉ ở sheet nhà ${s.reconciliation.onlyInHouse} · không mã ${s.reconciliation.noRef}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card title="Các dòng" pad={false}>
        <form method="get" className={`card-pad ${styles.filters}`}>
          <div className="field">
            <label htmlFor="f-d">Hướng xử lý</label>
            <select id="f-d" name="disposition" className="select" defaultValue={filter.disposition ?? ""}>
              <option value="">Tất cả</option>
              {DISPOSITIONS.map((d) => (
                <option key={d} value={d}>
                  {DISPOSITION_LABELS[d]} ({byD[d] ?? 0})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-i">Lý do</label>
            <select id="f-i" name="issue" className="select" defaultValue={filter.issue ?? ""}>
              <option value="">Tất cả</option>
              {Object.keys(ISSUE_DEFS).map((code) => (
                <option key={code} value={code}>
                  {ISSUE_LABELS[code]} ({byI[code] ?? 0})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-s">Sheet</label>
            <select id="f-s" name="sheet" className="select" defaultValue={filter.sheet ?? ""}>
              <option value="">Tất cả</option>
              {(stats.sheets ?? [])
                .filter((s) => s.role !== "other")
                .map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="row">
            <button type="submit" className="btn">
              Lọc
            </button>
            <Link className="btn" href={`/nhap-excel/${batch.id}`}>
              Bỏ lọc
            </Link>
          </div>
        </form>
        {!showGuest ? <p className="card-pad small muted">Tên và số điện thoại khách được ẩn vì bạn không có quyền xem liên hệ khách.</p> : null}
        {rows.items.length === 0 ? (
          <EmptyState title="Không có dòng phù hợp bộ lọc" />
        ) : (
          <div className="table-wrap">
            <table className={`table ${styles.rows}`}>
              <thead>
                <tr>
                  <th>Sheet · dòng</th>
                  <th>Hướng xử lý</th>
                  <th>Giá trị gốc</th>
                  <th>Đã hiểu</th>
                  <th>Lý do</th>
                </tr>
              </thead>
              <tbody>
                {rows.items.map((r) => {
                  const p = r.parsed;
                  return (
                    <tr key={r.id}>
                      <td className="strong">
                        {r.sheet}
                        <div className="small faint">dòng {r.row_number}</div>
                      </td>
                      <td>
                        <Badge tone={dispositionTone(r.disposition)}>{DISPOSITION_LABELS[r.disposition]}</Badge>
                        {r.booking_id && can(actor, "booking.view") ? (
                          <div className="small">
                            <Link href={`/bookings/${r.booking_id}`}>Mở booking</Link>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <dl className={styles.raw}>
                          {Object.entries(r.raw.columns).map(([h, v]) =>
                            v == null || v === "" ? null : (
                              <div key={h}>
                                <dt>{h}</dt>
                                <dd>
                                  {String(v)}
                                  {r.raw.dateCells?.includes(h) ? <span className="faint"> (ô Date)</span> : null}
                                </dd>
                              </div>
                            ),
                          )}
                        </dl>
                      </td>
                      <td>
                        {p ? (
                          <dl className={styles.raw}>
                            <div>
                              <dt>Mã · kênh</dt>
                              <dd>
                                {p.externalRef ?? "—"} · {p.channel ? CHANNEL_LABELS[p.channel] : "chưa rõ"}
                              </dd>
                            </div>
                            <div>
                              <dt>Phòng</dt>
                              <dd>
                                {p.unit ? `${p.unit.code} — ${p.unit.name}` : p.unitParts.length ? p.unitParts.map((u) => `${u.role === "move_to" ? "→ " : ""}${u.unitCode ?? `? (${u.text})`}`).join(", ") : "—"}
                              </dd>
                            </div>
                            <div>
                              <dt>Ở</dt>
                              <dd>
                                {formatDateVi(p.checkIn)} → {formatDateVi(p.checkOut)}
                                {p.totalGuests != null ? ` · ${p.totalGuests} khách` : ""}
                              </dd>
                            </div>
                            <div>
                              <dt>Nhận booking</dt>
                              <dd>
                                {formatDateVi(p.bookedDate)}
                                {p.bookedDateAmbiguous ? <span className="faint"> (mơ hồ)</span> : null}
                              </dd>
                            </div>
                            {p.guestName ? (
                              <div>
                                <dt>Khách</dt>
                                <dd>{p.guestName}</dd>
                              </div>
                            ) : null}
                            {p.paymentNote ? (
                              <div>
                                <dt>Khoản thu ghi chú</dt>
                                <dd>{p.paymentNote}</dd>
                              </div>
                            ) : null}
                          </dl>
                        ) : null}
                      </td>
                      <td>
                        {r.issues.length === 0 ? (
                          <span className="small faint">—</span>
                        ) : (
                          <ul className={styles.issues}>
                            {r.issues.map((i, idx) => (
                              <li key={idx}>
                                <Badge tone={i.severity === "block" ? "warn" : "neutral"}>{ISSUE_LABELS[i.code] ?? i.code}</Badge> <span className="small">{i.message}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad">
          <Pagination page={rows.page} pageSize={rows.pageSize} total={rows.total} hrefFor={(n) => `${qs({})}${qs({}).includes("?") ? "&" : "?"}page=${n}`} />
        </div>
      </Card>
    </div>
  );
}
