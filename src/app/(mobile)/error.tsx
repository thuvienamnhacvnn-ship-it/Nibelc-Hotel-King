"use client";

export default function MobileError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card card-pad stack" role="alert">
      <h1>Không tải được</h1>
      <p className="strong" style={{ margin: 0 }}>
        Mất mạng hoặc máy chủ gián đoạn. Chưa có thao tác nào bị thay đổi. {error.digest ? <span className="mono">Mã lỗi: {error.digest}</span> : null}
      </p>
      <button type="button" className="btn btn-primary btn-lg" onClick={reset}>
        Thử lại
      </button>
    </div>
  );
}
