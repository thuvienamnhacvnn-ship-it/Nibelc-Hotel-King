/** Tiền luôn là số nguyên theo đơn vị nhỏ nhất (cent). Chỉ định dạng khi hiển thị. */
export function parseMoneyToMinor(input: string): number {
  const cleaned = input.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error(`Số tiền không hợp lệ: ${input}`);
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function formatMoney(minor: number | null | undefined, currency = "EUR", locale = "vi-VN"): string {
  if (minor == null) return "—";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}
