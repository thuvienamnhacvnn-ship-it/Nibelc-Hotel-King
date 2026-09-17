/** Mỗi lần chuyển trang, React dựng lại template → nội dung trồi nhẹ (CSS .page-enter). */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
