/**
 * Che thông tin cá nhân trước khi gửi văn bản ra dịch vụ AI bên ngoài.
 * Giữ mã booking (chữ + số, ví dụ HM1005) và ngày tháng vì cần để hiểu câu hỏi;
 * che email, số điện thoại, dãy số dài (thẻ, mã khoá).
 */
const DATE_LIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

/** Dãy số có thể là mã đặt phòng — người gọi dùng để tra xem mã nào có thật rồi giữ lại. */
export function numberCandidates(text: string): string[] {
  return [...new Set(text.match(/(?<![A-Za-z\d])\d{6,14}(?![A-Za-z\d])/g) ?? [])];
}

/**
 * `keep` là những dãy số ĐÃ ĐƯỢC XÁC MINH là mã đặt phòng có thật trong hệ thống.
 *
 * Vì sao cần: mã Booking.com là 10 chữ số liền, trùng y dạng số điện thoại. Không có danh sách này
 * thì "mã 6857205481" bị che thành "mã [số điện thoại]" và trợ lý chép nguyên cái đó vào câu trả
 * lời gửi cho người thật — đã xảy ra ngày 04/10/2026 khi trả lời chị Dịu.
 *
 * Chỉ giữ mã đã tra ra trong bảng booking, KHÔNG nới luật đoán theo hình dạng: một số điện thoại
 * gõ liền không dấu cách trông giống hệt mã đơn, nới ra là lộ số của khách.
 */
export function redactForAi(text: string, keep: Iterable<string> = []): string {
  const giu = new Set(keep);
  const duocGiu = (s: string) => giu.has(s.replace(/\D/g, ""));

  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(?<![A-Za-z0-9])\+?\d[\d\s().-]{6,}\d(?![A-Za-z0-9])/g, (m) => {
      const digits = m.replace(/\D/g, "").length;
      // Ngày (24.09.2026, 2026-09-24) giữ nguyên; từ 8 chữ số trở lên coi là số điện thoại.
      if (DATE_LIKE.test(m.trim()) || digits < 8) return m;
      if (duocGiu(m)) return m;
      return "[số điện thoại]";
    })
    .replace(/(?<![A-Za-z\d])\d{6,}(?![A-Za-z\d])/g, (m) => (duocGiu(m) ? m : "[dãy số]"))
    .slice(0, 2000);
}
