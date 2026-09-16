/**
 * Sinh file Excel DEMO ẩn danh mô phỏng "Danh sách lịch đặt phòng" để kiểm thử và thử màn hình Nhập Excel.
 * KHÔNG chứa dữ liệu thật: mã phòng DEMO (A000–A003, B001, B002, B010, C001), khách "Khách Demo N",
 * SĐT +36 00 000 00NN, mã booking tự đặt.
 *
 * Ca khó được mô phỏng (số là STT trong sheet TH; dòng Excel = STT + 2):
 *   1  hợp lệ (Booking.com, tên "Demo A Phòng 1")          11 ghi chú là khoản thu "20e TM"
 *   2  hợp lệ, ngày nhận booking là ô Date ngày > 12        12 "khách hủy" + "đã hoàn tất" (mâu thuẫn)
 *   3  hợp lệ, cột căn hộ ghi thẳng mã "B010"               13 tên phòng chưa có alias
 *   4,5 mã lặp (một bản có khoảng trắng đầu/cuối)           14 số đêm không khớp ngày
 *   6  thiếu mã                                             15 vượt sức chứa
 *   7  chuyển phòng "=>"                                    16 ngày không tồn tại (31 tháng 9)
 *   8  ô nhiều dòng (2 phòng)                               17 nguyên căn A000 trùng đêm với dòng 1 ⇒ lỗi tồn khi áp dụng
 *   9  hai phòng nối bằng "+"                               18 kỳ ở quá khứ (2025), ngày nhận booking dd/mm/yyyy
 *   10 ngày nhận booking là ô Date ngày ≤ 12 (có thể đảo)   19 "Đánh dấu vắng mặt"
 *                                                            20 ghi chú Booking nhưng mã dạng Airbnb
 *   28 ghi chú vừa có kênh vừa có khoản thu ("Booking 460,86e TM") — hợp lệ, khoản thu được tách
 * Dòng 3 có mã trùng một dòng ở sheet Hủy ⇒ phải vào hàng kiểm tra.
 *   21 thiếu tên khách + trống căn hộ + thiếu ngày nhận booking   25 ngày ở là ô Date ngày ≤ 12
 *   22 ngày nhận booking không đọc được + số khách không phải số  26 ngày nhận booking sau ngày nhận phòng
 *   23 ngày trả trước ngày nhận                              27 LOẠI PHÒNG "nguyên căn" nhưng là phòng lẻ
 *   24 kỳ ở dài bất thường (sai năm)
 * Sheet "Demo A" (sheet nhà, tiêu đề dòng 2, có cột Back TH): trùng dòng 1, lệch ngày với dòng 11, một mã chỉ có ở sheet nhà.
 * Sheet "Hủy" (tiêu đề dòng 1): một mã trùng TH, một mã chỉ ở sheet Hủy. Sheet "DS Phòng" không có bảng booking.
 *
 * Chạy: npx tsx scripts/make-demo-excel.ts   → fixtures/demo-lich-dat-phong.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const HEADERS = [
  "STT",
  "NGÀY NHẬN BOOKING ",
  "KHÁCH",
  "GHI CHÚ",
  "CĂN HỘ",
  "MÃ ĐẶT PHÒNG",
  "THỜI GIAN NHẬN PHÒNG",
  "THỜI GIAN TRẢ PHÒNG",
  "SỐ ĐÊM",
  "LOẠI PHÒNG",
  "TỔNG SỐ KHÁCH",
  "GIỜ CHECK- IN",
  "TÌNH TRẠNG",
  "SĐT",
];

type Cell = string | number | Date | null;
const vn = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} tháng ${m} ${y}`;
};
const cellDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
};
const guest = (n: number) => `Khách Demo ${n}`;
const phone = (n: number) => `+36 00 000 00${String(n).padStart(2, "0")}`;

interface Row {
  booked: Cell;
  note: string | null;
  unit: string | null;
  ref: Cell;
  ci: Cell;
  co: Cell;
  nights: number;
  type: string;
  guests: Cell;
  checkin?: string | null;
  status?: string | null;
  /** Ghi đè tên khách (null = để trống) */
  guestName?: string | null;
}

const ROWS: Row[] = [
  { booked: "05/09/26", note: "Booking", unit: "Demo A Phòng 1", ref: 1000000001, ci: vn("2026-10-03"), co: vn("2026-10-05"), nights: 2, type: "1 phòng", guests: 2 },
  { booked: cellDate("2026-09-20"), note: "Airbnb", unit: "demo b phòng 1 ", ref: "HMDEMO0002", ci: vn("2026-10-10"), co: vn("2026-10-12"), nights: 2, type: "1 phòng", guests: 2, checkin: "check in lúc 18h" },
  { booked: "07/09/2026", note: "Booking.com", unit: "B010", ref: 1000000003, ci: vn("2026-10-20"), co: vn("2026-10-23"), nights: 3, type: "1 phòng", guests: 3 },
  { booked: "08/09/26", note: "Airbnb", unit: "Demo C Studio", ref: "HMDEMO0004", ci: vn("2026-11-01"), co: vn("2026-11-02"), nights: 1, type: "1 phòng", guests: 1 },
  { booked: "08/09/26", note: "Airbnb", unit: "Demo C Studio", ref: " HMDEMO0004 ", ci: vn("2026-11-01"), co: vn("2026-11-02"), nights: 1, type: "1 phòng", guests: 1 },
  { booked: "09/09/26", note: "Booking", unit: "Demo A Phòng 2", ref: null, ci: vn("2026-11-05"), co: vn("2026-11-07"), nights: 2, type: "1 phòng", guests: 2 },
  { booked: "10/09/26", note: "Booking", unit: "Demo A Phòng 2\n=> Demo A Phòng 3", ref: 1000000007, ci: vn("2026-11-10"), co: vn("2026-11-12"), nights: 2, type: "1 phòng", guests: 2 },
  { booked: "10/09/26", note: "Airbnb", unit: "Demo B Phòng 1\nDemo B Phòng 2", ref: "HMDEMO0008", ci: vn("2026-11-15"), co: vn("2026-11-17"), nights: 2, type: "2 phòng", guests: 4 },
  { booked: "11/09/26", note: "Booking", unit: "Demo A Phòng 2 + Demo A Phòng 3", ref: 1000000009, ci: vn("2026-11-20"), co: vn("2026-11-21"), nights: 1, type: "2 phòng", guests: 4 },
  { booked: cellDate("2026-03-04"), note: "Booking", unit: "Studio Demo C", ref: 1000000010, ci: vn("2026-10-01"), co: vn("2026-10-02"), nights: 1, type: "1 phòng", guests: 2 },
  { booked: "12/09/26", note: "20e TM", unit: "Demo A Phòng 2", ref: 1000000011, ci: vn("2026-12-01"), co: vn("2026-12-03"), nights: 2, type: "1 phòng", guests: 2 },
  { booked: "12/09/26", note: "Booking", unit: "Demo A Phòng 3", ref: 1000000012, ci: vn("2026-12-05"), co: vn("2026-12-06"), nights: 1, type: "1 phòng", guests: 2, checkin: "khách hủy", status: "đã hoàn tất" },
  { booked: "13/09/26", note: "Airbnb", unit: "Demo Z Phòng 9", ref: "HMDEMO0013", ci: vn("2026-12-10"), co: vn("2026-12-12"), nights: 2, type: "1 phòng", guests: 2 },
  { booked: "13/09/26", note: "Booking", unit: "Demo B Phòng 2", ref: 1000000014, ci: vn("2026-12-14"), co: vn("2026-12-16"), nights: 5, type: "1 phòng", guests: 2 },
  { booked: "14/09/26", note: "Booking", unit: "Demo A Phòng 1", ref: 1000000015, ci: vn("2026-12-20"), co: vn("2026-12-22"), nights: 2, type: "1 phòng", guests: 5 },
  { booked: "14/09/26", note: "Booking", unit: "Demo B Phòng 1", ref: 1000000016, ci: "31 tháng 9 2026", co: vn("2026-10-02"), nights: 1, type: "1 phòng", guests: 2 },
  { booked: "15/09/26", note: "Booking", unit: "Demo A nguyên căn", ref: 1000000017, ci: vn("2026-10-04"), co: vn("2026-10-06"), nights: 2, type: "nguyên căn", guests: 6 },
  { booked: "01/10/2025", note: "Airbnb", unit: "Demo A Phòng 3", ref: "HMDEMO0018", ci: vn("2025-11-01"), co: vn("2025-11-03"), nights: 2, type: "1 phòng", guests: 2, status: "đã hoàn tất" },
  { booked: "15/09/26", note: "Booking", unit: "Demo B Phòng 2", ref: 1000000019, ci: vn("2026-10-25"), co: vn("2026-10-26"), nights: 1, type: "1 phòng", guests: 2, checkin: "Đánh dấu vắng mặt" },
  { booked: "16/09/26", note: "Booking", unit: "Demo B Phòng 2", ref: "HMDEMO0020", ci: vn("2026-11-25"), co: vn("2026-11-27"), nights: 2, type: "1 phòng", guests: 2 },
  { booked: null, note: "Booking", unit: null, ref: 1000000021, ci: vn("2026-12-27"), co: vn("2026-12-28"), nights: 1, type: "1 phòng", guests: 1, guestName: null },
  { booked: "ngày 3", note: "Booking", unit: "Demo B Phòng 2", ref: 1000000022, ci: vn("2027-01-03"), co: vn("2027-01-04"), nights: 1, type: "1 phòng", guests: "hai" },
  { booked: "16/09/26", note: "Airbnb", unit: "Demo A Phòng 3", ref: "HMDEMO0023", ci: vn("2027-01-10"), co: vn("2027-01-08"), nights: 2, type: "1 phòng", guests: 2 },
  { booked: "16/09/26", note: "Airbnb", unit: "Demo A Phòng 3", ref: "HMDEMO0024", ci: vn("2027-01-12"), co: vn("2028-01-14"), nights: 367, type: "1 phòng", guests: 2 },
  { booked: "16/09/26", note: "Booking", unit: "Demo B Phòng 1", ref: 1000000025, ci: cellDate("2027-02-05"), co: vn("2027-02-06"), nights: 1, type: "1 phòng", guests: 2 },
  { booked: "20/02/27", note: "Booking", unit: "Demo B Phòng 1", ref: 1000000026, ci: vn("2027-02-10"), co: vn("2027-02-11"), nights: 1, type: "1 phòng", guests: 2 },
  { booked: "16/09/26", note: "Booking", unit: "Demo A Phòng 2", ref: 1000000027, ci: vn("2027-02-15"), co: vn("2027-02-16"), nights: 1, type: "nguyên căn", guests: 2 },
  { booked: "16/09/26", note: "Booking 460,86e TM", unit: "Studio Demo C", ref: 1000000028, ci: vn("2027-03-10"), co: vn("2027-03-12"), nights: 2, type: "1 phòng", guests: 2 },
];

function values(n: number, r: Row): Cell[] {
  return [n, r.booked, r.guestName === undefined ? guest(n) : r.guestName, r.note, r.unit, r.ref, r.ci, r.co, r.nights, r.type, r.guests, r.checkin ?? null, r.status ?? null, phone(n)];
}

async function main() {
  const wb = new ExcelJS.Workbook();
  // Metadata cố định; sha256 vẫn đổi mỗi lần sinh (zip ghi thời điểm) — kiểm thử dùng file đã commit.
  wb.creator = "NIBELC DEMO";
  wb.created = new Date(Date.UTC(2026, 8, 16));
  wb.modified = new Date(Date.UTC(2026, 8, 16));

  const th = wb.addWorksheet("TH");
  th.getRow(1).values = ["DANH SÁCH LỊCH ĐẶT PHÒNG (DEMO — dữ liệu giả)"];
  th.mergeCells(1, 1, 1, HEADERS.length);
  th.getRow(2).values = HEADERS;
  ROWS.forEach((r, i) => (th.getRow(i + 3).values = values(i + 1, r)));

  // Sheet nhà: tiêu đề dòng 2, "SỐ NGÀY" thay "SỐ ĐÊM", có cột Back TH, không có SĐT.
  const house = wb.addWorksheet("Demo A");
  house.getRow(1).values = ["DANH SÁCH LỊCH ĐẶT PHÒNG (DEMO)"];
  house.mergeCells(1, 1, 1, 12);
  house.getRow(2).values = [...HEADERS.slice(0, 8), "SỐ NGÀY", "LOẠI PHÒNG", "TỔNG SỐ KHÁCH", "Back TH"];
  const houseRow = (n: number, r: Row) => values(n, r).slice(0, 11).concat(["Back TH"]);
  house.getRow(3).values = houseRow(1, ROWS[0]);
  house.getRow(4).values = houseRow(11, { ...ROWS[10], co: vn("2026-12-04"), nights: 3 });
  house.getRow(5).values = houseRow(21, { booked: "16/09/26", note: "Booking", unit: "Demo A Phòng 3", ref: 1000000099, ci: vn("2026-12-24"), co: vn("2026-12-26"), nights: 2, type: "1 phòng", guests: 2 });

  // Sheet Hủy: tiêu đề ở dòng 1
  const cancel = wb.addWorksheet("Hủy");
  cancel.getRow(1).values = HEADERS.slice(0, 13);
  cancel.getRow(2).values = values(3, { ...ROWS[2], checkin: "Đánh dấu vắng mặt", status: "đã hoàn tất" }).slice(0, 13);
  cancel.getRow(3).values = values(22, { booked: "16/09/26", note: "Airbnb", unit: "Demo B Phòng 1", ref: "HMDEMO0077", ci: vn("2026-10-15"), co: vn("2026-10-16"), nights: 1, type: "1 phòng", guests: 1, checkin: "khách hủy" }).slice(0, 13);

  const ds = wb.addWorksheet("DS Phòng");
  ds.getRow(3).values = ["Nhà", "Tên phòng DEMO", "Sức chứa"];
  ds.getRow(4).values = ["Demo A", "Demo A Phòng 1", 2];

  const out = path.join(process.cwd(), "fixtures", "demo-lich-dat-phong.xlsx");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await wb.xlsx.writeFile(out);
  console.log(`Đã ghi ${path.relative(process.cwd(), out)} (${ROWS.length} dòng TH, DEMO ẩn danh)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
