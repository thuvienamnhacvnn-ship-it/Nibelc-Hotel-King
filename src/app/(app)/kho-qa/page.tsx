import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, Notice, PageHeader, Pagination } from "@/components/ui";
import { pageParams } from "@/lib/http";
import { requireActor } from "@/lib/session";
import { formatDateVi, todayOps } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { propertiesOf, unitOptions } from "@/modules/booking/queries";
import { QA_SCOPES, QA_SCOPE_LABELS, QA_SENSITIVITY_LABELS, QA_STATUSES, QA_STATUS_LABELS, qaSensitivityTone, qaStatusTone } from "@/modules/qa/labels";
import { listQaEntries, parseQaFilters, qaStatusCounts, qaTopics } from "@/modules/qa/queries";
import { CreateQaButton, EntryActions, type QaEntry, TryQuestion } from "./qa-client";
import s from "./kho-qa.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kho Q&A" };

const ser = <T,>(v: T) => JSON.parse(JSON.stringify(v)) as T;

export default async function QaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireActor("qa.view");
  const sp = await searchParams;
  const filters = parseQaFilters(sp);
  const pageQs = new URLSearchParams();
  for (const k of ["page", "pageSize"]) if (typeof sp[k] === "string") pageQs.set(k, sp[k]);
  const page = pageParams(new URL(`http://local/?${pageQs}`));
  const [data, units, topics, counts] = await Promise.all([listQaEntries(actor, filters, page), unitOptions(actor), qaTopics(actor), qaStatusCounts(actor)]);
  const properties = propertiesOf(units);
  const canEdit = can(actor, "qa.edit");
  const canApprove = can(actor, "qa.approve");
  const unitOpts = units.map((u) => ({ id: u.id, code: u.code, name: u.name, property_id: u.property_id, property_code: u.property_code }));

  const qs = new URLSearchParams();
  if (filters.scope) qs.set("scope", filters.scope);
  if (filters.propertyId) qs.set("property", filters.propertyId);
  if (filters.unitId) qs.set("unit", filters.unitId);
  if (filters.status) qs.set("status", filters.status);
  if (filters.topic) qs.set("topic", filters.topic);
  if (filters.q) qs.set("q", filters.q);
  const hasFilter = qs.toString() !== "";
  const hrefFor = (p: number) => {
    const next = new URLSearchParams(qs);
    next.set("page", String(p));
    return `/kho-qa?${next}`;
  };

  return (
    <div className="stack">
      <PageHeader
        title="Kho Q&A"
        description={`Câu trả lời đã duyệt cho trợ lý khách, theo phạm vi chung / nhà / phòng. ${counts.approved ?? 0} đã duyệt · ${counts.pending_review ?? 0} chờ duyệt · ${counts.draft ?? 0} nháp · ${counts.retired ?? 0} ngưng dùng.`}
        actions={canEdit ? <CreateQaButton units={unitOpts} properties={properties} topics={topics} /> : null}
      />

      <Notice tone="warn" title="Nội dung FAQ/nội quy chưa được nhập">
        Các link Google Docs FAQ và nội quy nhà trong đặc tả CHƯA được đưa vào kho — hệ thống không đọc link Google Docs. Cần xuất nội dung thành file (docx/txt) rồi nhập hoặc gõ vào từng mục. Không có câu đã duyệt thì bot chuyển người, không đoán.
      </Notice>
      <Notice tone="info">
        Không lưu mã cửa, mã hộp khoá hay mật khẩu trong Q&A (hệ thống từ chối nội dung giống mã). Sửa câu đã duyệt tạo phiên bản mới; bản cũ vẫn chạy tới khi bản mới được duyệt. Người soạn không tự duyệt.
      </Notice>

      <Card title="Thử câu hỏi (trước khi bật bot)">
        <TryQuestion units={unitOpts} today={todayOps(actor.timezone)} />
      </Card>

      <Card>
        <form method="get" className={s.filters}>
          <div className="field">
            <label htmlFor="f-scope">Phạm vi</label>
            <select id="f-scope" className="select" name="scope" defaultValue={filters.scope ?? ""}>
              <option value="">Tất cả</option>
              {QA_SCOPES.map((k) => (
                <option key={k} value={k}>
                  {QA_SCOPE_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-property">Nhà</label>
            <select id="f-property" className="select" name="property" defaultValue={filters.propertyId ?? ""}>
              <option value="">Tất cả</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-unit">Phòng</label>
            <select id="f-unit" className="select" name="unit" defaultValue={filters.unitId ?? ""}>
              <option value="">Tất cả</option>
              {properties.map((p) => (
                <optgroup key={p.id} label={p.code}>
                  {units
                    .filter((u) => u.property_id === p.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.code} — {u.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-status">Trạng thái</label>
            <select id="f-status" className="select" name="status" defaultValue={filters.status ?? ""}>
              <option value="">Đang dùng / đang soạn</option>
              {QA_STATUSES.map((k) => (
                <option key={k} value={k}>
                  {QA_STATUS_LABELS[k]}
                </option>
              ))}
              <option value="all">Tất cả (kể cả ngưng)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-topic">Chủ đề</label>
            <select id="f-topic" className="select" name="topic" defaultValue={filters.topic ?? ""}>
              <option value="">Tất cả</option>
              {topics.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-q">Tìm trong câu hỏi / trả lời</label>
            <input id="f-q" className="input" type="search" name="q" defaultValue={filters.q ?? ""} placeholder="VD: wifi" />
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary">
              Lọc
            </button>
            {hasFilter ? (
              <Link className="btn" href="/kho-qa">
                Bỏ lọc
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card title={`Mục Q&A (${data.total})`} pad={false}>
        {data.items.length === 0 ? (
          <EmptyState title={hasFilter ? "Không có mục nào khớp bộ lọc" : "Kho Q&A chưa có mục nào"}>
            {hasFilter ? "Thử bỏ bớt điều kiện lọc." : canEdit ? "Bấm “Thêm câu hỏi” để soạn bản nháp đầu tiên." : "Người có quyền soạn Q&A cần thêm nội dung."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className={`table ${s.table}`}>
              <thead>
                <tr>
                  <th>Chủ đề</th>
                  <th>Câu hỏi</th>
                  <th>Trả lời (EN)</th>
                  <th>Phạm vi</th>
                  <th>Trạng thái</th>
                  <th>Nhạy cảm</th>
                  <th>Hiệu lực</th>
                  <th>Người soạn / duyệt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="strong">
                      {e.topic} <DemoBadge show={e.is_demo} />
                    </td>
                    <td className={s.question}>
                      {e.question}
                      {e.variants.length ? <div className="small faint">+{e.variants.length} biến thể</div> : null}
                      {e.answer_vi ? <div className="small faint">có bản tiếng Việt</div> : null}
                    </td>
                    <td className={s.answerCell}>{e.answer_en}</td>
                    <td>
                      {QA_SCOPE_LABELS[e.scope]}
                      {e.scope === "unit" ? <div className="small">{e.unit_code}</div> : e.scope === "property" ? <div className="small">{e.property_code}</div> : null}
                    </td>
                    <td>
                      <Badge tone={qaStatusTone(e.status)}>{QA_STATUS_LABELS[e.status] ?? e.status}</Badge>
                      <div className="small faint">
                        v{e.version}
                        {e.version_count > 1 ? ` / ${e.version_count} phiên bản` : ""}
                      </div>
                      {e.status === "draft" && e.last_reject_reason ? <div className="small form-error">Bị từ chối: {e.last_reject_reason}</div> : null}
                    </td>
                    <td>
                      <Badge tone={qaSensitivityTone(e.sensitivity)}>{QA_SENSITIVITY_LABELS[e.sensitivity]}</Badge>
                      {e.handoff_condition ? <div className="small faint">{e.handoff_condition}</div> : null}
                    </td>
                    <td className="small">{e.valid_from || e.valid_to ? `${formatDateVi(e.valid_from)} → ${formatDateVi(e.valid_to)}` : <span className="faint">không giới hạn</span>}</td>
                    <td className="small">
                      {e.created_by_name ?? "—"}
                      <div className="faint">{e.approved_by_name ? `duyệt: ${e.approved_by_name}` : "chưa duyệt"}</div>
                    </td>
                    <td>
                      <EntryActions entry={ser(e) as unknown as QaEntry} canEdit={canEdit} canApprove={canApprove} currentUserId={actor.userId} units={unitOpts} properties={properties} topics={topics} />
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
