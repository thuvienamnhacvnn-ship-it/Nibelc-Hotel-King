import { navFor } from "@/components/nav";
import { LogoutButton, Shell } from "@/components/shell";
import { callName } from "@/lib/names";
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
  const shortName = callName(actor.fullName);
  const topbar = (
    <>
      <div className="topbar-meta">
        <span className="topbar-org">{org?.name}</span>
        {org?.is_demo ? <span className="topbar-demo" title="Dữ liệu mẫu ẩn danh — không phải dữ liệu vận hành thật">DEMO</span> : null}
        <span className="topbar-sep" aria-hidden />
        <span>
          {weekdayVi(today)} {formatDateVi(today)} · Budapest ({tzAbbrev(now(), actor.timezone)})
        </span>
      </div>
      <div className="topbar-meta">
        <span
          className={`topbar-health ${bg.workerAlive && !bg.dead ? "ok" : "bad"}`}
          title={bg.workerAlive ? (bg.dead ? `${bg.dead} sự kiện nền lỗi — xem Agent Center` : "Việc nền đang chạy bình thường") : "Không nhận nhịp từ worker trong 60 giây — việc dọn và cảnh báo sẽ chậm cập nhật"}
        >
          {bg.workerAlive ? (bg.dead ? `${bg.dead} việc nền lỗi` : "Hệ thống ổn định") : `Việc nền không chạy${bg.pending ? ` · ${bg.pending} chờ` : ""}`}
        </span>
        <span className="topbar-sep" aria-hidden />
        <span className="topbar-user" title={actor.role ? ROLE_LABELS[actor.role] : undefined}>
          <span className="topbar-avatar">{shortName.slice(0, 1).toUpperCase()}</span>
          <span>
            <span className="strong">{shortName}</span>
            <span className="topbar-role">{actor.role ? ROLE_LABELS[actor.role] : ""}</span>
          </span>
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
