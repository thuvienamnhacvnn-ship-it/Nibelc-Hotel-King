export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <div className="muted">Đang tải dữ liệu…</div>
      <div className="card" style={{ height: 120, opacity: 0.6 }} />
      <div className="card" style={{ height: 240, opacity: 0.4 }} />
    </div>
  );
}
