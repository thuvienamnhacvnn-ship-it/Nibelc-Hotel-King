/**
 * Che thông tin cá nhân trước khi gửi văn bản ra dịch vụ AI bên ngoài.
 * Giữ mã booking (chữ + số, ví dụ HM1005) và ngày tháng vì cần để hiểu câu hỏi;
 * che email, số điện thoại, dãy số dài (thẻ, mã khoá).
 */
const DATE_LIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

export function redactForAi(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(?<![A-Za-z0-9])\+?\d[\d\s().-]{6,}\d(?![A-Za-z0-9])/g, (m) => {
      const digits = m.replace(/\D/g, "").length;
      // Ngày (24.09.2026, 2026-09-24) giữ nguyên; từ 8 chữ số trở lên coi là số điện thoại.
      if (DATE_LIKE.test(m.trim()) || digits < 8) return m;
      return "[số điện thoại]";
    })
    .replace(/(?<![A-Za-z\d])\d{6,}(?![A-Za-z\d])/g, "[dãy số]")
    .slice(0, 2000);
}
