"use client";

import { useState } from "react";
import { type ApiError, Dialog, ErrorText, callApi, useAction } from "@/components/client";
import { QA_AUDIT_LABELS, QA_SCOPE_LABELS, QA_SENSITIVITY_LABELS, QA_STATUS_LABELS, qaSensitivityTone, qaStatusTone } from "@/modules/qa/labels";
import s from "./kho-qa.module.css";

export interface UnitOpt {
  id: string;
  code: string;
  name: string;
  property_id: string;
  property_code: string;
}
export interface PropertyOpt {
  id: string;
  code: string;
  name: string;
}
export interface QaEntry {
  id: string;
  entry_key: string;
  version: number;
  scope: string;
  property_id: string | null;
  unit_id: string | null;
  property_code: string | null;
  unit_code: string | null;
  topic: string;
  question: string;
  variants: string[];
  answer_en: string;
  answer_vi: string | null;
  sensitivity: string;
  handoff_condition: string | null;
  source: string | null;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  created_by: string | null;
  created_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  is_demo: boolean;
  updated_at: string;
}

const Pill = ({ tone, children }: { tone: string; children: React.ReactNode }) => <span className={`badge badge-${tone}`}>{children}</span>;
const dateVi = (d: string | null) => (d ? d.split("-").reverse().join("/") : "—");
const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("vi-VN", { timeZone: "Europe/Budapest", dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) + " (Budapest)" : "—";

// ───────────────────────── Biểu mẫu nội dung ─────────────────────────

type Mode = "create" | "edit" | "revise";

function emptyForm(entry?: QaEntry) {
  return {
    scope: entry?.scope ?? "general",
    propertyId: entry?.property_id ?? "",
    unitId: entry?.unit_id ?? "",
    topic: entry?.topic ?? "",
    question: entry?.question ?? "",
    variants: (entry?.variants ?? []).join("\n"),
    answerEn: entry?.answer_en ?? "",
    answerVi: entry?.answer_vi ?? "",
    sensitivity: entry?.sensitivity ?? "public",
    handoffCondition: entry?.handoff_condition ?? "",
    source: entry?.source ?? "",
    validFrom: entry?.valid_from ?? "",
    validTo: entry?.valid_to ?? "",
  };
}

function QaFormDialog({
  mode,
  entry,
  open,
  onClose,
  units,
  properties,
  topics,
}: {
  mode: Mode;
  entry?: QaEntry;
  open: boolean;
  onClose: () => void;
  units: UnitOpt[];
  properties: PropertyOpt[];
  topics: string[];
}) {
  const [f, setF] = useState(() => emptyForm(entry));
  const { run, busy, error, setError } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const id = `qa-${mode}-${entry?.id ?? "new"}`;

  function close() {
    setError(null);
    setF(emptyForm(entry));
    onClose();
  }

  async function save() {
    const contentBody = {
      scope: f.scope,
      propertyId: f.scope === "property" ? f.propertyId || null : null,
      unitId: f.scope === "unit" ? f.unitId || null : null,
      topic: f.topic,
      question: f.question,
      variants: f.variants.split("\n").map((v) => v.trim()).filter(Boolean),
      answerEn: f.answerEn,
      answerVi: f.answerVi || null,
      sensitivity: f.sensitivity,
      handoffCondition: f.handoffCondition || null,
      source: f.source || null,
      validFrom: f.validFrom || null,
      validTo: f.validTo || null,
    };
    const res =
      mode === "create"
        ? await run("/api/v1/qa", { body: contentBody })
        : mode === "edit"
          ? await run(`/api/v1/qa/${entry!.id}`, { method: "PATCH", body: { expectedUpdatedAt: entry!.updated_at, content: contentBody } })
          : await run(`/api/v1/qa/${entry!.id}/revise`, { body: { expectedUpdatedAt: entry!.updated_at, content: contentBody } });
    if (!res.error) close();
  }

  const title = mode === "create" ? "Thêm câu hỏi (bản nháp)" : mode === "edit" ? `Sửa bản nháp v${entry!.version}` : `Sửa thành phiên bản mới (v${entry!.version} → bản nháp mới)`;
  const fieldErrors = new Map(((error?.details as { path?: string; message: string }[] | undefined) ?? []).filter((d) => d && d.path).map((d) => [d.path!, d.message]));

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Huỷ
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? "Đang lưu…" : mode === "revise" ? "Tạo phiên bản mới" : "Lưu nháp"}
          </button>
        </>
      }
    >
      <div className="stack">
        {mode === "revise" ? <div className="notice notice-info small">Bản đang duyệt vẫn được bot dùng cho tới khi bản mới được người khác duyệt.</div> : null}
        <div className="notice notice-warn small">Không ghi mã cửa, mã hộp khoá, mật khẩu Wi-Fi hay mật khẩu nào vào Q&A — hệ thống sẽ từ chối. Mã truy cập lấy qua công cụ có kiểm quyền theo booking.</div>
        <div className={s.formGrid}>
          <div className="field">
            <label htmlFor={`${id}-scope`}>Phạm vi</label>
            <select id={`${id}-scope`} className="select" value={f.scope} onChange={set("scope")}>
              {Object.entries(QA_SCOPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          {f.scope === "property" ? (
            <div className="field">
              <label htmlFor={`${id}-prop`}>Nhà</label>
              <select id={`${id}-prop`} className="select" value={f.propertyId} onChange={set("propertyId")}>
                <option value="">— chọn nhà —</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {f.scope === "unit" ? (
            <div className="field">
              <label htmlFor={`${id}-unit`}>Phòng / căn</label>
              <select id={`${id}-unit`} className="select" value={f.unitId} onChange={set("unitId")}>
                <option value="">— chọn phòng —</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.property_code} · {u.code} — {u.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={`${id}-topic`}>Chủ đề</label>
            <input id={`${id}-topic`} className="input" list={`${id}-topics`} value={f.topic} onChange={set("topic")} maxLength={80} placeholder="check-in, wifi, parking…" />
            <datalist id={`${id}-topics`}>
              {topics.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor={`${id}-sens`}>Mức nhạy cảm</label>
            <select id={`${id}-sens`} className="select" value={f.sensitivity} onChange={set("sensitivity")}>
              {Object.entries(QA_SENSITIVITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${id}-q`}>Câu hỏi</label>
          <input id={`${id}-q`} className="input" value={f.question} onChange={set("question")} maxLength={500} placeholder="What time is check-in?" />
          {fieldErrors.get("question") ? <div className="form-error">{fieldErrors.get("question")}</div> : null}
        </div>
        <div className="field">
          <label htmlFor={`${id}-var`}>Biến thể (mỗi dòng một cách hỏi, vi/en)</label>
          <textarea id={`${id}-var`} className="textarea" rows={3} value={f.variants} onChange={set("variants")} placeholder={"When can I check in?\nMấy giờ nhận phòng?"} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-en`}>Câu trả lời tiếng Anh (bắt buộc — bot trả lời bằng bản này)</label>
          <textarea id={`${id}-en`} className="textarea" rows={4} value={f.answerEn} onChange={set("answerEn")} maxLength={4000} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-vi`}>Câu trả lời tiếng Việt (tuỳ chọn)</label>
          <textarea id={`${id}-vi`} className="textarea" rows={3} value={f.answerVi} onChange={set("answerVi")} maxLength={4000} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-handoff`}>Điều kiện chuyển người{f.sensitivity === "handoff" ? " (bắt buộc)" : ""}</label>
          <input id={`${id}-handoff`} className="input" value={f.handoffCondition} onChange={set("handoffCondition")} maxLength={1000} placeholder="VD: khách hỏi giá, chưa có dữ liệu xác nhận…" />
        </div>
        <div className={s.formGrid}>
          <div className="field">
            <label htmlFor={`${id}-src`}>Nguồn</label>
            <input id={`${id}-src`} className="input" value={f.source} onChange={set("source")} maxLength={1000} placeholder="File Vietnam Team, nội quy nhà…" />
          </div>
          <div className="field">
            <label htmlFor={`${id}-from`}>Hiệu lực từ (Budapest)</label>
            <input id={`${id}-from`} type="date" className="input" value={f.validFrom} onChange={set("validFrom")} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-to`}>Hiệu lực đến (hết ngày)</label>
            <input id={`${id}-to`} type="date" className="input" value={f.validTo} onChange={set("validTo")} />
          </div>
        </div>
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

export function CreateQaButton(props: { units: UnitOpt[]; properties: PropertyOpt[]; topics: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        Thêm câu hỏi
      </button>
      {open ? <QaFormDialog mode="create" open={open} onClose={() => setOpen(false)} {...props} /> : null}
    </>
  );
}

// ───────────────────────── Thao tác theo dòng ─────────────────────────

function ReasonDialog({ open, onClose, title, hint, confirmLabel, danger, onConfirm, busy, error }: { open: boolean; onClose: () => void; title: string; hint: string; confirmLabel: string; danger?: boolean; onConfirm: (reason: string) => void; busy: boolean; error: ApiError | null }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy || reason.trim().length < 3} onClick={() => onConfirm(reason)}>
            {busy ? "Đang gửi…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">{hint}</div>
        <div className="field">
          <label htmlFor={`reason-${title}`}>Lý do (bắt buộc)</label>
          <textarea id={`reason-${title}`} className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        </div>
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

export function EntryActions({
  entry,
  canEdit,
  canApprove,
  currentUserId,
  units,
  properties,
  topics,
}: {
  entry: QaEntry;
  canEdit: boolean;
  canApprove: boolean;
  currentUserId: string | null;
  units: UnitOpt[];
  properties: PropertyOpt[];
  topics: string[];
}) {
  const [dialog, setDialog] = useState<null | "edit" | "revise" | "reject" | "retire" | "approve">(null);
  const action = useAction();
  const close = () => {
    setDialog(null);
    action.setError(null);
  };
  const post = async (path: string, body: Record<string, unknown> = {}) => {
    const res = await action.run(`/api/v1/qa/${entry.id}/${path}`, { body: { expectedUpdatedAt: entry.updated_at, ...body } });
    if (!res.error) close();
  };
  const own = !!currentUserId && entry.created_by === currentUserId;

  return (
    <div className={s.actions}>
      {canEdit && (entry.status === "draft" || entry.status === "pending_review") ? (
        <button type="button" className="btn btn-sm" onClick={() => setDialog("edit")}>
          Sửa
        </button>
      ) : null}
      {canEdit && entry.status === "draft" ? (
        <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => post("submit")}>
          Gửi duyệt
        </button>
      ) : null}
      {canApprove && entry.status === "pending_review" ? (
        own ? (
          <span className="small faint" title="Người soạn không tự duyệt">
            Chờ người khác duyệt
          </span>
        ) : (
          <>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog("approve")}>
              Duyệt
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setDialog("reject")}>
              Từ chối
            </button>
          </>
        )
      ) : null}
      {canEdit && (entry.status === "approved" || entry.status === "retired") ? (
        <button type="button" className="btn btn-sm" onClick={() => setDialog("revise")}>
          Sửa thành bản mới
        </button>
      ) : null}
      {entry.status !== "retired" && (entry.status === "approved" ? canApprove : canEdit) ? (
        <button type="button" className="btn btn-sm btn-danger" onClick={() => setDialog("retire")}>
          Ngưng
        </button>
      ) : null}
      <HistoryButton entryId={entry.id} />
      {!dialog ? <ErrorText error={action.error} /> : null}

      {dialog === "edit" || dialog === "revise" ? <QaFormDialog mode={dialog} entry={entry} open onClose={close} units={units} properties={properties} topics={topics} /> : null}
      {dialog === "approve" ? (
        <Dialog
          open
          onClose={close}
          title={`Duyệt v${entry.version}: ${entry.question}`}
          footer={
            <>
              <button type="button" className="btn" onClick={close} disabled={action.busy}>
                Huỷ
              </button>
              <button type="button" className="btn btn-primary" onClick={() => post("approve")} disabled={action.busy}>
                {action.busy ? "Đang duyệt…" : "Duyệt — bot được dùng câu này"}
              </button>
            </>
          }
        >
          <div className="stack">
            <div className="small muted">
              {QA_SCOPE_LABELS[entry.scope]} {entry.unit_code ?? entry.property_code ?? ""} · {QA_SENSITIVITY_LABELS[entry.sensitivity]} · hiệu lực {dateVi(entry.valid_from)} → {dateVi(entry.valid_to)}
            </div>
            <div className={s.answer}>{entry.answer_en}</div>
            {entry.answer_vi ? <div className={s.answer}>{entry.answer_vi}</div> : null}
            {entry.version > 1 ? <div className="notice notice-info small">Bản đang duyệt trước đó của câu hỏi này sẽ tự chuyển “Ngưng dùng”.</div> : null}
            <ErrorText error={action.error} />
          </div>
        </Dialog>
      ) : null}
      {dialog === "reject" ? (
        <ReasonDialog open onClose={close} title="Từ chối — trả về nháp" hint="Bản này quay về nháp để người soạn sửa. Lý do hiện cạnh câu hỏi." confirmLabel="Từ chối" danger busy={action.busy} error={action.error} onConfirm={(reason) => post("reject", { reason })} />
      ) : null}
      {dialog === "retire" ? (
        <ReasonDialog
          open
          onClose={close}
          title="Ngưng dùng"
          hint={entry.status === "approved" ? "Bot sẽ thôi dùng câu trả lời này ngay; khách hỏi câu này sẽ được chuyển người nếu không còn câu khác phù hợp." : "Bỏ bản nháp này. Vẫn xem lại được trong lịch sử phiên bản."}
          confirmLabel="Ngưng dùng"
          danger
          busy={action.busy}
          error={action.error}
          onConfirm={(reason) => post("retire", { reason })}
        />
      ) : null}
    </div>
  );
}

// ───────────────────────── Lịch sử phiên bản ─────────────────────────

interface HistoryData {
  versions: QaEntry[];
  events: { id: number; action: string; entity_id: string; detail: Record<string, unknown> | null; created_at: string; actor_name: string | null; actor_type: string }[];
}

function HistoryButton({ entryId }: { entryId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setOpen(true);
    setLoading(true);
    setError(null);
    const res = await callApi<HistoryData>(`/api/v1/qa/${entryId}`);
    setLoading(false);
    if (res.error) setError(res.error);
    else setData(res.data ?? null);
  }

  const versionOf = new Map((data?.versions ?? []).map((v) => [v.id, v.version]));
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={load}>
        Phiên bản
      </button>
      {open ? (
        <Dialog open onClose={() => setOpen(false)} title="Lịch sử phiên bản">
          <div className="stack">
            {loading ? <div className="small muted">Đang tải…</div> : null}
            <ErrorText error={error} />
            {data?.versions.map((v) => (
              <div key={v.id} className={s.version}>
                <div className="row small">
                  <strong>v{v.version}</strong>
                  <Pill tone={qaStatusTone(v.status)}>{QA_STATUS_LABELS[v.status] ?? v.status}</Pill>
                  <Pill tone={qaSensitivityTone(v.sensitivity)}>{QA_SENSITIVITY_LABELS[v.sensitivity]}</Pill>
                  <span className="faint">
                    {QA_SCOPE_LABELS[v.scope]} {v.unit_code ?? v.property_code ?? ""} · hiệu lực {dateVi(v.valid_from)} → {dateVi(v.valid_to)}
                  </span>
                </div>
                <div className="small">
                  <strong>{v.question}</strong>
                  {v.variants.length ? <span className="faint"> · {v.variants.join(" · ")}</span> : null}
                </div>
                <div className={s.answer}>{v.answer_en}</div>
                {v.answer_vi ? <div className={s.answer}>{v.answer_vi}</div> : null}
                <div className="small faint">
                  Soạn: {v.created_by_name ?? "—"} · Duyệt: {v.approved_by_name ?? "—"} {v.approved_at ? `lúc ${when(v.approved_at)}` : ""}
                  {v.source ? ` · Nguồn: ${v.source}` : ""}
                </div>
              </div>
            ))}
            {data ? (
              <div>
                <div className="label">Nhật ký</div>
                <ul className={s.events}>
                  {data.events.map((e) => (
                    <li key={e.id} className="small">
                      {when(e.created_at)} — v{versionOf.get(e.entity_id) ?? "?"} · {QA_AUDIT_LABELS[e.action] ?? e.action} · {e.actor_name ?? e.actor_type}
                      {typeof e.detail?.reason === "string" ? <span className="muted"> — {e.detail.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

// ───────────────────────── Thử câu hỏi ─────────────────────────

interface LookupResult {
  answer: { entryId: string; version: number; scope: string; topic: string; answer: string; language: string; sensitivity: string; score: number } | null;
  grounding: { question: string; variants: string[]; source: string | null; handoff_condition: string | null; valid_from: string | null; valid_to: string | null; approved_at: string | null; approved_by_name: string | null; property_code: string | null; unit_code: string | null } | null;
  minScore: number;
  opsDate: string;
}

export function TryQuestion({ units, today }: { units: UnitOpt[]; today: string }) {
  const [text, setText] = useState("");
  const [unitId, setUnitId] = useState("");
  const [verification, setVerification] = useState("none");
  const [language, setLanguage] = useState("en");
  const [opsDate, setOpsDate] = useState(today);
  const [result, setResult] = useState<LookupResult | null>(null);
  const { run, busy, error } = useAction();

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const res = await run<LookupResult>("/api/v1/qa/lookup", { body: { text, unitId: unitId || null, verification, language, opsDate } }, { refresh: false });
    setResult(res.data ?? null);
  }

  const a = result?.answer;
  const g = result?.grounding;
  return (
    <form onSubmit={ask} className="stack">
      <div className={s.tryGrid}>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="try-text">Câu khách hỏi</label>
          <input id="try-text" className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="VD: Hi, what time can I check in? / Có chỗ đỗ xe không?" />
        </div>
        <div className="field">
          <label htmlFor="try-unit">Phòng của khách</label>
          <select id="try-unit" className="select" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">(chưa biết phòng — chỉ câu chung)</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.property_code} · {u.code} — {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="try-ver">Mức xác minh khách</label>
          <select id="try-ver" className="select" value={verification} onChange={(e) => setVerification(e.target.value)}>
            <option value="none">Chưa khớp booking</option>
            <option value="matched">Đã khớp booking</option>
            <option value="verified">Đã xác thực bổ sung</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="try-lang">Ngôn ngữ trả lời</label>
          <select id="try-lang" className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">English</option>
            <option value="vi">Tiếng Việt (nếu có)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="try-date">Ngày (Budapest)</label>
          <input id="try-date" type="date" className="input" value={opsDate} onChange={(e) => setOpsDate(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
          {busy ? "Đang tra…" : "Thử tra cứu"}
        </button>
        <span className="small faint">Chỉ dùng câu đã duyệt, còn hiệu lực. Không gửi gì cho khách.</span>
      </div>
      <ErrorText error={error} />
      {result && !a ? (
        <div className="notice notice-warn small">
          Không có câu trả lời đã duyệt đủ khớp (ngưỡng {result.minScore}) cho ngày {dateVi(result.opsDate)}. Bot sẽ nói chưa xác nhận được và chuyển người — không đoán.
        </div>
      ) : null}
      {a && g ? (
        <div className={s.tryResult}>
          <div className="row small">
            <Pill tone={a.sensitivity === "handoff" ? "danger" : "ok"}>{a.sensitivity === "handoff" ? "Chuyển người — bot KHÔNG gửi câu này" : "Bot trả lời được"}</Pill>
            <Pill tone={qaSensitivityTone(a.sensitivity)}>{QA_SENSITIVITY_LABELS[a.sensitivity]}</Pill>
            <span>
              Điểm khớp <strong>{a.score.toFixed(2)}</strong> <span className="faint">(theo từ khoá, ngưỡng {result!.minScore})</span>
            </span>
          </div>
          <div className={s.answer}>{a.answer}</div>
          <div className="small muted">
            Căn cứ: v{a.version} “{g.question}” · {QA_SCOPE_LABELS[a.scope]} {g.unit_code ?? g.property_code ?? ""} · chủ đề {a.topic} · {a.language === "vi" ? "tiếng Việt" : "English"}
            <br />
            Duyệt bởi {g.approved_by_name ?? "—"} {g.approved_at ? `lúc ${when(g.approved_at)}` : ""} · hiệu lực {dateVi(g.valid_from)} → {dateVi(g.valid_to)}
            {g.source ? ` · Nguồn: ${g.source}` : ""}
            {g.handoff_condition ? ` · Điều kiện chuyển người: ${g.handoff_condition}` : ""}
          </div>
        </div>
      ) : null}
    </form>
  );
}
