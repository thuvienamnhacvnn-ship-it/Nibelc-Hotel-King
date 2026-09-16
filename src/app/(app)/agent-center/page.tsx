import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, KeyValue, Notice, PageHeader, Pagination, Tabs } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { requireActor } from "@/lib/session";
import { formatInstant, now, tzAbbrev } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { ROLE_LABELS, type Role } from "@/modules/auth/permissions";
import { ESCALATION_PURPOSES, PURPOSE_LABELS, raiseSystemAlerts } from "@/modules/manager/escalation";
import {
  AGENT_ROLE_LABELS,
  AGENT_RUN_STATUS_LABELS,
  CHANNEL_NAME_LABELS,
  NOTIFICATION_STATUS_LABELS,
  OUTBOX_STATUS_LABELS,
  SUBSCRIPTION_KIND_LABELS,
  SWITCH_LABELS,
  TEMPLATE_KEY_LABELS,
  TEMPLATE_STATUS_LABELS,
} from "@/modules/manager/labels";
import {
  AGENT_RUN_STATUSES,
  NOTIFICATION_STATUSES,
  aiBudget,
  listAgentRuns,
  listEscalationContacts,
  listOutbox,
  listStaffNotifications,
  listSubscriptions,
  listSwitches,
  listTemplates,
  staffOptions,
  workerStatus,
} from "@/modules/manager/queries";
import { canRetryOutbox } from "@/modules/manager/service";
import { RATE_LIMIT_PER_ORG_HOUR, SUPPRESSED_REASON_LABELS } from "@/modules/notifications/sender";
import { sendFailureLabel } from "@/modules/inbox/transport";
import { orgInfo } from "@/modules/system/queries";
import {
  AddContactForm,
  AddSubscriptionForm,
  ApproveTemplateButton,
  ContactActions,
  RetireTemplateButton,
  RetryOutboxButton,
  SubscriptionActions,
  SwitchButton,
  TemplateEditor,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent Center" };

type SP = Promise<Record<string, string | string[] | undefined>>;

const TABS = [
  { key: "tong-quan", label: "Công tắc & nhịp" },
  { key: "thong-bao", label: "Hàng đợi thông báo" },
  { key: "nguoi-truc", label: "Người trực" },
  { key: "mau-tin", label: "Mẫu tin" },
  { key: "dang-ky", label: "Đăng ký báo cáo" },
  { key: "chay", label: "Lượt chạy trợ lý" },
  { key: "outbox", label: "Sự kiện nền" },
] as const;

export default async function AgentCenterPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor(["automation.pause", "reports.view"]);
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const tab = TABS.find((t) => t.key === str("tab"))?.key ?? "tong-quan";
  const rawPage = Number(str("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= 100_000 ? rawPage : 1;
  const pp = { page, pageSize: 50, offset: (page - 1) * 50 };
  const status = str("status");
  const hrefFor = (extra: Record<string, string | null>) => {
    const q = new URLSearchParams({ tab });
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return `/agent-center?${q.toString()}`;
  };
  const org = await orgInfo(actor.orgId);
  const canEdit = can(actor, "automation.pause");

  return (
    <div className="stack">
      <PageHeader
        title={
          <>
            Agent Center <DemoBadge show={!!org?.is_demo} />
          </>
        }
        description={`Dừng/chạy tự động, xem hàng đợi thông báo, người trực, mẫu tin và việc nền. Giờ theo Budapest (${tzAbbrev(now(), actor.timezone)}). Hệ thống vẫn làm tay được khi mọi trợ lý đang dừng.`}
      />
      <Tabs tabs={TABS.map((t) => ({ key: t.key, label: t.label, href: `/agent-center?tab=${t.key}` }))} current={tab} />
      {!canEdit ? <Notice tone="info">Bạn chỉ có quyền xem. Thay đổi công tắc, người trực và đăng ký cần quyền dừng tự động.</Notice> : null}

      {tab === "tong-quan" ? <OverviewTab actor={actor} canEdit={canEdit} /> : null}
      {tab === "thong-bao" ? <NotificationsTab actor={actor} status={status} pp={pp} hrefFor={hrefFor} /> : null}
      {tab === "nguoi-truc" ? <ContactsTab actor={actor} canEdit={canEdit} /> : null}
      {tab === "mau-tin" ? <TemplatesTab actor={actor} /> : null}
      {tab === "dang-ky" ? <SubscriptionsTab actor={actor} canEdit={canEdit} /> : null}
      {tab === "chay" ? <RunsTab actor={actor} status={status} pp={pp} hrefFor={hrefFor} /> : null}
      {tab === "outbox" ? <OutboxTab actor={actor} status={status} pp={pp} hrefFor={hrefFor} /> : null}
    </div>
  );
}

type A = Awaited<ReturnType<typeof requireActor>>;
type PP = { page: number; pageSize: number; offset: number };
type HrefFor = (extra: Record<string, string | null>) => string;

async function OverviewTab({ actor, canEdit }: { actor: A; canEdit: boolean }) {
  const [switches, worker, budget, org] = await Promise.all([listSwitches(actor), workerStatus(), aiBudget(actor), orgInfo(actor.orgId)]);
  const lastBeat = worker?.last_beat_at ? new Date(worker.last_beat_at) : null;
  const alive = !!lastBeat && now().getTime() - lastBeat.getTime() < 60_000;
  // Worker mất nhịp: xếp thông báo trong app cho người trực kỹ thuật (idempotent theo mốc nhịp cuối).
  if (!alive) await raiseSystemAlerts(actor.orgId, now(), { workerLastBeat: lastBeat }).catch(() => undefined);
  const orgSwitch = switches.find((s) => s.scope === "org");
  const periodic = (worker?.detail?.periodic ?? {}) as Record<string, string>;

  return (
    <>
      {orgSwitch?.paused ? (
        <Notice tone="danger" title="Toàn bộ tự động của tổ chức đang DỪNG">
          {orgSwitch.reason}
        </Notice>
      ) : null}
      <Card title="Công tắc tự động" pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Phạm vi</th>
                <th>Trạng thái</th>
                <th>Lý do / người đổi gần nhất</th>
                {canEdit ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {switches.map((s) => {
                const meta = SWITCH_LABELS[`${s.scope}:${s.key}`] ?? { label: `${s.scope}:${s.key}`, hint: "" };
                return (
                  <tr key={`${s.scope}:${s.key}`}>
                    <td>
                      <div className="strong">{meta.label}</div>
                      <div className="small faint">{meta.hint}</div>
                    </td>
                    <td>
                      {s.paused ? <Badge tone="danger">Đang dừng</Badge> : <Badge tone="ok">Cho chạy</Badge>}
                      {!s.exists && s.scope !== "org" ? <div className="small faint">Chưa bật lần nào (mặc định dừng)</div> : null}
                    </td>
                    <td className="small">
                      {s.reason ?? <span className="faint">—</span>}
                      {s.updatedAt ? (
                        <div className="faint">
                          {s.updatedBy ?? "hệ thống"} · {formatInstant(s.updatedAt, actor.timezone)}
                        </div>
                      ) : null}
                    </td>
                    {canEdit ? (
                      <td>
                        <SwitchButton scope={s.scope} switchKey={s.key} label={meta.label} paused={s.paused} />
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Nhịp worker nền">
          {lastBeat ? (
            <KeyValue
              items={[
                ["Trạng thái", alive ? <Badge tone="ok">Đang chạy</Badge> : <Badge tone="danger">Mất nhịp</Badge>],
                ["Nhịp gần nhất", formatInstant(lastBeat, actor.timezone)],
                ...Object.entries(periodic).map(([name, r]) => [<span key={name} className="mono small">{name}</span>, r === "ok" ? <Badge tone="ok">ok</Badge> : <Badge tone="danger">{r}</Badge>] as [React.ReactNode, React.ReactNode]),
              ]}
            />
          ) : (
            <EmptyState title="Worker chưa từng chạy">
              Chạy <span className="mono">npm run worker</span>. Khi worker tắt: không đẩy cảnh báo, không gửi thông báo — đội vẫn làm tay trên web.
            </EmptyState>
          )}
          {lastBeat && !alive ? <div className="small muted">Đã xếp thông báo trong ứng dụng cho người trực kỹ thuật (hoặc quản trị).</div> : null}
        </Card>
        <Card title="Ngân sách AI">
          <KeyValue
            items={[
              ["Lượt chạy trợ lý đã ghi", budget.runs],
              ["Ngân sách đã cấp", formatMoney(budget.budget, org?.currency ?? "EUR")],
              ["Chi phí đã dùng", formatMoney(budget.cost, org?.currency ?? "EUR")],
            ]}
          />
          <div className="small muted" style={{ marginTop: 8 }}>
            GPU/model chưa kết nối — các con số trên là tổng từ bảng lượt chạy, hiện chưa có lượt nào dùng AI. Hạn mức gửi WhatsApp nội bộ: {RATE_LIMIT_PER_ORG_HOUR} tin/giờ, 1 tin/phút/người, chỉ tới số đã
            từng nhắn vào tổng đài.
          </div>
        </Card>
      </div>
    </>
  );
}

async function NotificationsTab({ actor, status, pp, hrefFor }: { actor: A; status: string | null; pp: PP; hrefFor: HrefFor }) {
  const data = await listStaffNotifications(actor, status, pp);
  return (
    <Card
      title="Hàng đợi thông báo cho đội"
      pad={false}
      actions={
        <div className="row small">
          <Link href={hrefFor({})} className={!data.status ? "strong" : undefined}>
            Tất cả
          </Link>
          {NOTIFICATION_STATUSES.map((s) => (
            <Link key={s} href={hrefFor({ status: s })} className={data.status === s ? "strong" : undefined}>
              {NOTIFICATION_STATUS_LABELS[s][0]} ({data.counts[s] ?? 0})
            </Link>
          ))}
        </div>
      }
    >
      {data.items.length === 0 ? (
        <EmptyState title="Không có thông báo">Cảnh báo đẩy lên cấp trên, báo cáo theo lịch và cảnh báo kỹ thuật sẽ xuất hiện ở đây kèm lý do nếu không gửi.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Lúc tạo</th>
                <th>Người nhận</th>
                <th>Mẫu / kênh</th>
                <th>Trạng thái</th>
                <th>Nội dung / lý do</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((n) => {
                const st = NOTIFICATION_STATUS_LABELS[n.status] ?? [n.status, "neutral"];
                return (
                  <tr key={n.id}>
                    <td className="small">{formatInstant(n.created_at, actor.timezone)}</td>
                    <td className="strong">{n.recipient_name}</td>
                    <td className="small">
                      <span className="mono">{n.template_key}</span>
                      <div className="faint">{CHANNEL_NAME_LABELS[n.channel] ?? n.channel}</div>
                    </td>
                    <td>
                      <Badge tone={st[1]}>{st[0]}</Badge>
                      {n.sent_at ? <div className="small faint">{formatInstant(n.sent_at, actor.timezone)}</div> : null}
                    </td>
                    <td className="small">
                      {n.suppressed_reason ? <div className="strong">{SUPPRESSED_REASON_LABELS[n.suppressed_reason] ?? n.suppressed_reason}</div> : null}
                      {n.error ? <div className="muted">{n.status === "failed" ? sendFailureLabel(n.error) : n.error}</div> : null}
                      {n.rendered_body ? <div style={{ whiteSpace: "pre-wrap" }}>{n.rendered_body}</div> : typeof n.payload.title === "string" ? <div>{n.payload.title}</div> : typeof n.payload.summary === "string" && n.template_key !== "daily_report" ? <div>{n.payload.summary}</div> : null}
                      {typeof n.payload.link === "string" && n.payload.link.startsWith("/") ? <Link href={n.payload.link}>Mở</Link> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-pad">
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => hrefFor({ status: data.status, page: String(p) })} />
      </div>
    </Card>
  );
}

async function ContactsTab({ actor, canEdit }: { actor: A; canEdit: boolean }) {
  const [contacts, staff] = await Promise.all([listEscalationContacts(actor), staffOptions(actor)]);
  const staffOpts = staff.map((s) => ({ id: s.id, label: `${s.full_name} — ${ROLE_LABELS[s.role as Role] ?? s.role}${s.duties.length ? ` (${s.duties.join(", ")})` : ""}` }));
  return (
    <>
      <Notice tone="info">
        Việc khẩn (P0/P1) chưa ai nhận quá hạn thì báo cấp kế tiếp của đúng mục đích; hết cấp thì báo Leader (không có Leader thì quản trị). Yêu cầu chuyển người hết cấp chuyển sang “hẹn gọi lại” — không bao giờ ghi đã kết
        nối. Hạn nhận mỗi cấp: 5 phút (đề xuất, cần đội vận hành chốt).
      </Notice>
      {canEdit ? (
        <Card title="Thêm người trực">
          <AddContactForm staff={staffOpts} purposes={ESCALATION_PURPOSES.map((p) => ({ id: p, label: PURPOSE_LABELS[p] }))} />
        </Card>
      ) : null}
      {ESCALATION_PURPOSES.map((purpose) => {
        const rows = contacts.filter((c) => c.purpose === purpose);
        return (
          <Card key={purpose} title={PURPOSE_LABELS[purpose]} pad={false}>
            {rows.length === 0 ? (
              <EmptyState title="Chưa cấu hình">Cảnh báo loại này đi thẳng lên Leader.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="num">Cấp</th>
                      <th>Người</th>
                      <th>Tình trạng</th>
                      {canEdit ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id}>
                        <td className="num strong">{c.level}</td>
                        <td>
                          <div className="strong">{c.full_name}</div>
                          <div className="small faint">{ROLE_LABELS[c.role as Role] ?? c.role}</div>
                        </td>
                        <td>
                          {c.active && c.user_active ? <Badge tone="ok">Đang trực</Badge> : <Badge tone="neutral">{c.user_active ? "Tạm nghỉ" : "Tài khoản khoá"}</Badge>}{" "}
                          {!c.has_phone ? <Badge tone="warn">Chưa có số điện thoại</Badge> : null}
                        </td>
                        {canEdit ? (
                          <td>
                            <ContactActions id={c.id} level={c.level} active={c.active} name={c.full_name} />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}

async function TemplatesTab({ actor }: { actor: A }) {
  const templates = await listTemplates(actor);
  const canSave = can(actor, "templates.approve") || can(actor, "automation.pause");
  const canApprove = can(actor, "templates.approve");
  return (
    <Card title="Mẫu tin cho đội" pad={false} actions={canSave ? <TemplateEditor keys={TEMPLATE_KEY_LABELS} /> : null}>
      <div className="card-pad small muted">Chỉ mẫu đã duyệt mới được dùng để gửi. Người soạn (hoặc sửa gần nhất) không tự duyệt mẫu của mình. Sửa mẫu đã duyệt sẽ đưa về nháp.</div>
      {templates.length === 0 ? (
        <EmptyState title="Chưa có mẫu tin">Mọi tin WhatsApp cho đội đang bị chặn với lý do “Mẫu tin chưa được duyệt”.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Mẫu</th>
                <th>Nội dung</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => {
                const st = TEMPLATE_STATUS_LABELS[t.status] ?? [t.status, "neutral"];
                const label = `${t.key} (${t.language})`;
                return (
                  <tr key={t.id}>
                    <td>
                      <div className="mono strong">{t.key}</div>
                      <div className="small faint">
                        {TEMPLATE_KEY_LABELS[t.key] ?? "Mẫu tuỳ chỉnh"} · {t.language}
                      </div>
                    </td>
                    <td className="small" style={{ whiteSpace: "pre-wrap", maxWidth: 420 }}>
                      {t.body}
                    </td>
                    <td className="small">
                      <Badge tone={st[1]}>{st[0]}</Badge>
                      <div className="faint">Soạn: {t.author_name ?? "script DEMO / không rõ"}</div>
                      {t.approved_by_name ? (
                        <div className="faint">
                          Duyệt: {t.approved_by_name} · {formatInstant(t.approved_at, actor.timezone)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div className="row">
                        {canSave && t.status !== "retired" ? <TemplateEditor keys={TEMPLATE_KEY_LABELS} initial={{ key: t.key, language: t.language, body: t.body, status: t.status }} /> : null}
                        {canApprove && t.status === "draft" ? (
                          <ApproveTemplateButton id={t.id} label={label} blockedReason={t.author_id && t.author_id === actor.userId ? "Bạn là người soạn — cần người khác duyệt" : null} />
                        ) : null}
                        {canApprove && t.status !== "retired" ? <RetireTemplateButton id={t.id} label={label} /> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

async function SubscriptionsTab({ actor, canEdit }: { actor: A; canEdit: boolean }) {
  const [subs, staff] = await Promise.all([listSubscriptions(actor), staffOptions(actor)]);
  return (
    <>
      <Notice tone="warn" title="Lịch 08:00 / 20:00 là đề xuất, cần Ngọc/Dịu chốt">
        Đăng ký mới luôn ở trạng thái tắt. Báo cáo chỉ tự lập và xếp hàng gửi khi: đăng ký bật, công tắc “Gửi báo cáo theo lịch” và “Agent Manager” cho chạy; gửi WhatsApp còn cần công tắc “WhatsApp nội bộ”, mẫu{" "}
        <span className="mono">daily_report</span> đã duyệt và hạn mức. Giờ theo Budapest.
      </Notice>
      {canEdit ? (
        <Card title="Thêm đăng ký">
          <AddSubscriptionForm staff={staff.map((s) => ({ id: s.id, label: `${s.full_name} — ${ROLE_LABELS[s.role as Role] ?? s.role}` }))} />
        </Card>
      ) : null}
      <Card title="Đăng ký nhận báo cáo" pad={false}>
        {subs.length === 0 ? (
          <EmptyState title="Chưa có đăng ký nào">Chưa gửi báo cáo cho ai.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Người nhận</th>
                  <th>Loại</th>
                  <th>Kênh</th>
                  <th>Giờ (Budapest)</th>
                  <th>Trạng thái</th>
                  {canEdit ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td className="strong">{s.full_name}</td>
                    <td>{SUBSCRIPTION_KIND_LABELS[s.kind] ?? s.kind}</td>
                    <td>{CHANNEL_NAME_LABELS[s.channel] ?? s.channel}</td>
                    <td>{s.send_time ? s.send_time.slice(0, 5) : "—"}</td>
                    <td>{s.enabled ? <Badge tone="ok">Bật</Badge> : <Badge tone="neutral">Tắt</Badge>}</td>
                    {canEdit ? (
                      <td>
                        <SubscriptionActions id={s.id} enabled={s.enabled} label={`${s.full_name} · ${SUBSCRIPTION_KIND_LABELS[s.kind] ?? s.kind}`} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

async function RunsTab({ actor, status, pp, hrefFor }: { actor: A; status: string | null; pp: PP; hrefFor: HrefFor }) {
  const data = await listAgentRuns(actor, status, pp);
  return (
    <Card
      title="Lượt chạy trợ lý"
      pad={false}
      actions={
        <div className="row small">
          <Link href={hrefFor({})} className={!data.status ? "strong" : undefined}>
            Tất cả
          </Link>
          {AGENT_RUN_STATUSES.map((s) => (
            <Link key={s} href={hrefFor({ status: s })} className={data.status === s ? "strong" : undefined}>
              {AGENT_RUN_STATUS_LABELS[s][0]}
            </Link>
          ))}
        </div>
      }
    >
      {data.items.length === 0 ? (
        <EmptyState title="Chưa có lượt chạy nào">Các trợ lý AI chưa chạy (GPU/model chưa kết nối). Việc nền theo quy tắc (đẩy cảnh báo, gửi thông báo) xem ở tab “Hàng đợi thông báo”.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Lúc tạo</th>
                <th>Trợ lý</th>
                <th>Việc</th>
                <th>Trạng thái</th>
                <th className="num">Lần thử</th>
                <th>Lỗi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => {
                const st = AGENT_RUN_STATUS_LABELS[r.status] ?? [r.status, "neutral"];
                return (
                  <tr key={r.id}>
                    <td className="small">{formatInstant(r.created_at, actor.timezone)}</td>
                    <td>{AGENT_ROLE_LABELS[r.agent_role] ?? r.agent_role}</td>
                    <td className="small mono">
                      {r.task_key}
                      {r.entity_type ? <div className="faint">{r.entity_type}</div> : null}
                    </td>
                    <td>
                      <Badge tone={st[1]}>{st[0]}</Badge>
                    </td>
                    <td className="num">
                      {r.attempt}/{r.max_attempts}
                    </td>
                    <td className="small">{r.error ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-pad">
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => hrefFor({ status: data.status, page: String(p) })} />
      </div>
    </Card>
  );
}

async function OutboxTab({ actor, status, pp, hrefFor }: { actor: A; status: string | null; pp: PP; hrefFor: HrefFor }) {
  const data = await listOutbox(actor, status, pp);
  const canRetry = canRetryOutbox(actor);
  return (
    <Card
      title="Sự kiện nền chưa xong"
      pad={false}
      actions={
        <div className="row small">
          <Link href={hrefFor({})} className={!data.status ? "strong" : undefined}>
            Tất cả
          </Link>
          {(["dead", "pending", "processing"] as const).map((s) => (
            <Link key={s} href={hrefFor({ status: s })} className={data.status === s ? "strong" : undefined}>
              {OUTBOX_STATUS_LABELS[s][0]}
            </Link>
          ))}
        </div>
      }
    >
      {data.items.length === 0 ? (
        <EmptyState title="Không có sự kiện tồn">Mọi sự kiện nền đã xử lý xong.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Lúc tạo</th>
                <th>Chủ đề</th>
                <th>Trạng thái</th>
                <th className="num">Lần thử</th>
                <th>Lỗi gần nhất</th>
                {canRetry ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => {
                const st = OUTBOX_STATUS_LABELS[e.status] ?? [e.status, "neutral"];
                return (
                  <tr key={e.id}>
                    <td className="small">{formatInstant(e.created_at, actor.timezone)}</td>
                    <td className="mono small">
                      {e.topic}
                      <div className="faint">{e.aggregate_type}</div>
                    </td>
                    <td>
                      <Badge tone={st[1]}>{st[0]}</Badge>
                      {e.status === "pending" ? <div className="small faint">thử lúc {formatInstant(e.available_at, actor.timezone)}</div> : null}
                    </td>
                    <td className="num">
                      {e.attempts}/{e.max_attempts}
                    </td>
                    <td className="small">{e.last_error ?? "—"}</td>
                    {canRetry ? <td>{e.status !== "processing" ? <RetryOutboxButton id={e.id} topic={e.topic} /> : null}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-pad">
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => hrefFor({ status: data.status, page: String(p) })} />
      </div>
    </Card>
  );
}
