import ExcelJS from "exceljs";
import { invalid } from "@/lib/errors";
import { formatInstant } from "@/lib/time";
import { type Actor, assertCan, can } from "@/modules/auth/actor";
import { type BookingFilters, type BookingListItem, listBookings } from "./queries";
import { BOOKING_STATUS_LABELS, CHANNEL_LABELS, PAYMENT_STATUS_LABELS, STAY_STATUS_LABELS } from "./types";

/** Giới hạn dòng xuất một lần — lớn hơn thì yêu cầu thu hẹp bộ lọc thay vì làm treo máy chủ. */
export const EXPORT_MAX_ROWS = 10_000;

interface Column {
  header: string;
  width: number;
  value: (b: BookingListItem) => string | number | Date | null;
}

function allocationText(b: BookingListItem) {
  return b.allocations
    .map((a) => `${a.unit_code}${a.status === "conflict" ? " [XUNG ĐỘT]" : ""}${a.start_date !== b.check_in_date || a.end_date !== b.check_out_date ? ` (${a.start_date}→${a.end_date})` : ""}`)
    .join("\n");
}

/**
 * Xuất .xlsx cùng cột với bảng /bookings và tôn trọng quyền: không có quyền thì cột khách / số tiền không xuất hiện
 * (dữ liệu cũng không được truy vấn — listBookings đã thay bằng NULL trong SQL).
 */
export async function exportBookingsXlsx(actor: Actor, filters: BookingFilters): Promise<{ buffer: Buffer; rows: number }> {
  assertCan(actor, "booking.view");
  const showGuest = can(actor, "booking.view_guest_contact");
  const showMoney = can(actor, "revenue.view");

  const items: BookingListItem[] = [];
  const pageSize = 500;
  for (let page = 1; ; page++) {
    const res = await listBookings(actor, filters, { page, pageSize, offset: (page - 1) * pageSize });
    if (res.total > EXPORT_MAX_ROWS) throw invalid(`Bộ lọc trả về ${res.total} booking, vượt giới hạn ${EXPORT_MAX_ROWS} dòng mỗi lần xuất. Thu hẹp khoảng ngày.`);
    items.push(...res.items);
    if (items.length >= res.total || res.items.length === 0) break;
  }

  const columns: Column[] = [
    { header: "STT", width: 6, value: (b) => b.stt },
    { header: "Ngày nhận booking", width: 22, value: (b) => (b.booking_created_at ? formatInstant(b.booking_created_at, actor.timezone) : null) },
    ...(showGuest
      ? [
          { header: "Khách", width: 24, value: (b: BookingListItem) => b.guest_name },
          { header: "SĐT", width: 16, value: (b: BookingListItem) => b.guest_phone },
        ]
      : []),
    { header: "Kênh", width: 14, value: (b) => CHANNEL_LABELS[b.source_channel] ?? b.source_channel },
    { header: "Tài khoản kênh", width: 16, value: (b) => b.source_account || null },
    { header: "Ghi chú kênh", width: 30, value: (b) => b.channel_note },
    { header: "Ghi chú vận hành", width: 30, value: (b) => b.ops_note },
    { header: "Căn/phòng", width: 22, value: allocationText },
    { header: "Mã đặt phòng", width: 18, value: (b) => b.external_ref },
    { header: "Ngày nhận", width: 12, value: (b) => b.check_in_date },
    { header: "Ngày trả", width: 12, value: (b) => b.check_out_date },
    { header: "Số đêm", width: 8, value: (b) => b.nights },
    { header: "Người lớn", width: 9, value: (b) => b.adults },
    { header: "Trẻ em", width: 8, value: (b) => b.children },
    { header: "Tổng khách", width: 10, value: (b) => b.total_guests },
    { header: "ETA", width: 8, value: (b) => b.eta_local },
    { header: "Trạng thái booking", width: 16, value: (b) => BOOKING_STATUS_LABELS[b.booking_status] ?? b.booking_status },
    { header: "Lưu trú", width: 14, value: (b) => STAY_STATUS_LABELS[b.stay_status] ?? b.stay_status },
    { header: "Thanh toán", width: 16, value: (b) => PAYMENT_STATUS_LABELS[b.payment_status] ?? b.payment_status },
    ...(showMoney
      ? [
          { header: "Số tiền", width: 12, value: (b: BookingListItem) => (b.total_amount_minor == null ? null : b.total_amount_minor / 100) },
          { header: "Tiền tệ", width: 8, value: (b: BookingListItem) => b.currency },
        ]
      : []),
    { header: "Yêu cầu thay đổi chờ", width: 12, value: (b) => b.pending_changes },
    { header: "Xung đột mở", width: 10, value: (b) => b.open_conflicts },
    { header: "Đồng bộ gần nhất", width: 22, value: (b) => (b.last_synced_at ? formatInstant(b.last_synced_at, actor.timezone) : null) },
    { header: "DEMO", width: 7, value: (b) => (b.is_demo ? "DEMO" : null) },
  ];

  const wb = new ExcelJS.Workbook();
  wb.creator = "Vietduc Hotel";
  wb.created = new Date();
  const ws = wb.addWorksheet("Booking", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  for (const b of items) {
    const row = ws.addRow(columns.map((c) => c.value(b)));
    row.alignment = { vertical: "top", wrapText: true };
  }
  if (showMoney) {
    const idx = columns.findIndex((c) => c.header === "Số tiền") + 1;
    // Tiền lưu cent (số nguyên); chia 100 chỉ ở bước hiển thị trong ô Excel.
    ws.getColumn(idx).numFmt = "#,##0.00";
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, rows: items.length };
}
