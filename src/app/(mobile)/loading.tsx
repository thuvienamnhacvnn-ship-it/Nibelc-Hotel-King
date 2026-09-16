export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <div className="strong">Đang tải việc…</div>
      <div className="card" style={{ height: 120, opacity: 0.6 }} />
      <div className="card" style={{ height: 120, opacity: 0.4 }} />
    </div>
  );
}
