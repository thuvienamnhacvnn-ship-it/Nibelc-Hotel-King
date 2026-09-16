import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{ minHeight: "60vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card card-pad stack" style={{ maxWidth: 420 }}>
        <h1>Không tìm thấy</h1>
        <p className="muted" style={{ margin: 0 }}>
          Mục này không tồn tại hoặc không thuộc phạm vi bạn được xem.
        </p>
        <Link className="btn btn-primary" href="/">
          Về trang chính
        </Link>
      </div>
    </div>
  );
}
