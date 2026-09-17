/**
 * Tên gọi ngắn để chào / hiển thị gọn:
 * "Dịu — Vietnam team (DEMO)" → "Dịu", "Nguyễn Thị Ngọc" → "Ngọc", "Quản trị (DEMO)" → "Quản trị".
 */
export function callName(fullName: string): string {
  const base = (fullName.split(/\s+[—–-]\s+/)[0] ?? fullName).replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const words = base.split(/\s+/).filter(Boolean);
  if (words.length >= 3) return words[words.length - 1]!;
  return base || fullName;
}
