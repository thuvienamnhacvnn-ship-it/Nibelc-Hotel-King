export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <span className="sr-only">Đang tải dữ liệu…</span>
      <div className="skeleton" style={{ height: 34, width: 260 }} />
      <div className="kpi-row">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" style={{ height: 96 }} />
        ))}
      </div>
      <div className="grid grid-2">
        <div className="skeleton" style={{ height: 260 }} />
        <div className="skeleton" style={{ height: 260 }} />
      </div>
    </div>
  );
}
