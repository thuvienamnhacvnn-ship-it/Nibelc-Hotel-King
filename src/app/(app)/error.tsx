"use client";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card card-pad stack" role="alert">
      <h1>Không tải được màn hình</h1>
      <p className="muted" style={{ margin: 0 }}>
        Có thể database hoặc máy chủ đang gián đoạn. Dữ liệu chưa bị thay đổi. {error.digest ? <span className="mono">Mã lỗi: {error.digest}</span> : null}
      </p>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={reset}>
          Thử lại
        </button>
      </div>
    </div>
  );
}
