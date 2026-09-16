import Link from "next/link";

export const metadata = { title: "Không đủ quyền" };

export default function ForbiddenPage() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card card-pad stack" style={{ maxWidth: 460 }}>
        <h1>Không đủ quyền</h1>
        <p className="muted" style={{ margin: 0 }}>
          Tài khoản của bạn không được phép mở màn hình này. Nếu cần quyền, liên hệ quản trị hệ thống — quyền được cấp theo vai trò, không cấp theo từng người.
        </p>
        <div className="row">
          <Link className="btn btn-primary" href="/">
            Về trang chính
          </Link>
        </div>
      </div>
    </div>
  );
}
