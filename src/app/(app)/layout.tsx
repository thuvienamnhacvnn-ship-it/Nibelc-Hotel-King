import { DemoBadge, Badge } from "@/components/ui";
import { navFor } from "@/components/nav";
import { LogoutButton, Shell } from "@/components/shell";
import { requireActor } from "@/lib/session";
import { formatDateVi, now, todayOps, tzAbbrev, weekdayVi } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { ROLE_LABELS } from "@/modules/auth/permissions";
import { backgroundStatus, navBadges, orgInfo } from "@/modules/system/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const [org, bg, badges] = await Promise.all([orgInfo(actor.orgId), backgroundStatus(actor.orgId), navBadges(actor)]);
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
        <span>
          {actor.fullName} · {actor.role ? ROLE_LABELS[actor.role] : ""}
        </span>
        <LogoutButton />
      </div>
    </>
  );
  const quickActions = [
    ...(can(actor, "booking.create") ? [{ href: "/bookings/moi", label: "Tạo booking", icon: "Plus" }] : []),
    ...(can(actor, "import.preview") ? [{ href: "/nhap-excel", label: "Nhập Excel", icon: "FileSpreadsheet" }] : []),
  ];
  return (
    <Shell
      nav={navFor(actor).map((g) => ({ group: g.group, items: g.items.map(({ href, label, icon }) => ({ href, label, icon })) }))}
      topbar={topbar}
      mobile={{
        orgName: org?.name ?? "",
        isDemo: !!org?.is_demo,
        userName: actor.fullName,
        roleLabel: actor.role ? ROLE_LABELS[actor.role] : "",
        dateLabel: `${weekdayVi(today)} ${formatDateVi(today).slice(0, 5)} · ${tzAbbrev(now(), actor.timezone)}`,
        workerAlive: bg.workerAlive,
        badges,
        quickActions,
      }}
    >
      {children}
    </Shell>
  );
}
