import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, HelpNote, Notice, PageHeader } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { formatInstant, now, tzAbbrev } from "@/lib/time";
import { ROLE_LABELS, ROLES } from "@/modules/auth/permissions";
import { listUsers } from "@/modules/auth/user-queries";
import { orgInfo } from "@/modules/system/queries";
import { UserActions } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Người dùng" };

export default async function UsersPage() {
  const actor = await requireActor("users.manage");
  const [users, org] = await Promise.all([listUsers(actor), orgInfo(actor.orgId)]);
  const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));
  const noPassword = users.filter((u) => u.active && !u.has_password).length;

  return (
    <div className="stack">
      <PageHeader
        title={
          <>
            Người dùng <DemoBadge show={!!org?.is_demo} />
          </>
        }
        description={`Tài khoản của ${org?.name ?? "tổ chức"} · giờ Budapest (${tzAbbrev(now(), actor.timezone)})`}
        actions={
          <Link href="/tai-khoan" className="btn">
            Đổi mật khẩu của tôi
          </Link>
        }
      />

      {noPassword ? (
        <Notice tone="warn" title={`${noPassword} tài khoản chưa có mật khẩu`}>
          Những người này chưa đăng nhập được. Bấm “Đặt lại mật khẩu” để cấp mật khẩu tạm, rồi gửi RIÊNG cho đúng người đó.
        </Notice>
      ) : null}

      <Card title={`Danh sách (${users.length})`} pad={false}>
        {users.length === 0 ? (
          <EmptyState title="Chưa có tài khoản nào">Tài khoản được tạo ở cơ sở dữ liệu; màn hình này để cấp mật khẩu, đổi vai trò và khoá/mở.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Người</th>
                  <th>Vai trò</th>
                  <th>Điện thoại</th>
                  <th>Trạng thái</th>
                  <th>Đăng nhập gần nhất</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const locked = !!u.locked_until && new Date(u.locked_until) > now();
                  const isSelf = u.id === actor.userId;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="strong">
                          {u.full_name} {isSelf ? <span className="small faint">(bạn)</span> : null} <DemoBadge show={u.is_demo} />
                        </div>
                        <div className="small faint mono">{u.email}</div>
                      </td>
                      <td>
                        <div>{ROLE_LABELS[u.role] ?? u.role}</div>
                        {u.duties.length ? <div className="small faint">{u.duties.join(", ")}</div> : null}
                      </td>
                      <td className="small">{u.phone ?? <span className="faint">—</span>}</td>
                      <td>
                        {u.active ? <Badge tone="ok">Hoạt động</Badge> : <Badge tone="neutral">Đã khoá</Badge>}{" "}
                        {u.has_password ? null : <Badge tone="warn">Chưa có mật khẩu</Badge>}{" "}
                        {locked ? <Badge tone="danger" title="Nhập sai mật khẩu nhiều lần">Tạm khoá tới {formatInstant(u.locked_until, actor.timezone)}</Badge> : null}
                        {u.active_sessions ? <div className="small faint">{u.active_sessions} phiên đang mở</div> : null}
                      </td>
                      <td className="small">{u.last_login_at ? formatInstant(u.last_login_at, actor.timezone) : <span className="faint">chưa lần nào</span>}</td>
                      <td>
                        <UserActions id={u.id} name={u.full_name} email={u.email} role={u.role} active={u.active} isSelf={isSelf} roles={roleOptions} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <HelpNote title="Mật khẩu và quyền">
        Mật khẩu tạm hiện đúng MỘT lần trên màn hình — hệ thống không lưu lại bản đọc được, không ai (kể cả quản trị) xem lại được. Gửi riêng cho đúng người, không dán vào nhóm chat. Đặt lại mật khẩu hoặc khoá tài
        khoản sẽ huỷ ngay mọi phiên đang mở của người đó. Tài khoản không bị xoá, chỉ khoá — để nhật ký vẫn truy được ai đã làm gì. Bạn không tự đổi vai trò, không tự khoá và không tự đặt lại mật khẩu của chính
        mình; mật khẩu của bạn đổi ở “Tài khoản của tôi”. Mọi thao tác ở đây đều vào Nhật ký.
      </HelpNote>
    </div>
  );
}
