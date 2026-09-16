import { DemoBadge, Badge } from "@/components/ui";
import { navFor } from "@/components/nav";
import { LogoutButton, Shell } from "@/components/shell";
import { requireActor } from "@/lib/session";
import { formatDateVi, now, todayOps, tzAbbrev, weekdayVi } from "@/lib/time";
import { ROLE_LABELS } from "@/modules/auth/permissions";
import { backgroundStatus, orgInfo } from "@/modules/system/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const [org, bg] = await Promise.all([orgInfo(actor.orgId), backgroundStatus(actor.orgId)]);
  const today = todayOps(actor.timezone);
  const topbar = (
    <>
      <div className="topbar-meta">
        <span className="strong" style={{ color: "var(--navy-900)" }}>
          {org?.name}
        </span>
        <DemoBadge show={!!org?.is_demo} />
        <span>
          {weekdayVi(today)} {formatDateVi(today)} · giờ Budapest ({tzAbbrev(now(), actor.timezone)})
        </span>
        {bg.workerAlive ? (
          <Badge tone="ok" title="Worker nền đang chạy">
            Worker chạy
          </Badge>
        ) : (
          <Badge tone="danger" title="Không nhận nhịp từ worker trong 60 giây — việc dọn và cảnh báo sẽ chậm cập nhật">
            Worker không chạy{bg.pending ? ` · ${bg.pending} sự kiện chờ` : ""}
          </Badge>
        )}
        {bg.dead ? <Badge tone="danger">{bg.dead} sự kiện nền lỗi</Badge> : null}
      </div>
      <div className="topbar-meta">
        <span className="hide-mobile">
          {actor.fullName} · {actor.role ? ROLE_LABELS[actor.role] : ""}
        </span>
        <LogoutButton />
      </div>
    </>
  );
  return (
    <Shell nav={navFor(actor).map((g) => ({ group: g.group, items: g.items.map(({ href, label, icon }) => ({ href, label, icon })) }))} topbar={topbar}>
      {children}
    </Shell>
  );
}
