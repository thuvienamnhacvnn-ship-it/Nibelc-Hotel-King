import { Card, KeyValue, PageHeader } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { ROLE_LABELS } from "@/modules/auth/permissions";
import { listUsers } from "@/modules/auth/user-queries";
import { orgInfo } from "@/modules/system/queries";
import { ChangePasswordForm } from "./change-password-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tài khoản của tôi" };

/** Trang cho chính người đang đăng nhập — không cần quyền gì, chỉ xem và đổi mật khẩu của bản thân. */
export default async function MyAccountPage() {
  const actor = await requireActor();
  const org = await orgInfo(actor.orgId);
  // Email nằm ở bảng users, không có trong actor của phiên; chỉ lấy khi người này được phép đọc danh sách.
  const me = actor.permissions.has("users.manage") ? (await listUsers(actor)).find((u) => u.id === actor.userId) : null;

  return (
    <div className="stack">
      <PageHeader title="Tài khoản của tôi" description="Thông tin đăng nhập của chính bạn" />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Thông tin">
          <KeyValue
            items={[
              ["Tên", actor.fullName],
              ["Vai trò", actor.role ? ROLE_LABELS[actor.role] : "—"],
              ...(me ? ([["Email", <span key="e" className="mono">{me.email}</span>]] as [React.ReactNode, React.ReactNode][]) : []),
              ["Tổ chức", org?.name ?? "—"],
              ["Múi giờ", actor.timezone],
            ]}
          />
        </Card>
        <Card title="Đổi mật khẩu">
          <ChangePasswordForm />
        </Card>
      </div>
    </div>
  );
}
