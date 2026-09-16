import { z } from "zod";
import { isValidDate } from "@/lib/time";

export const BOOKING_STATUSES = ["hold", "confirmed", "cancelled"] as const;
export const STAY_STATUSES = ["expected", "checked_in", "checked_out", "no_show", "unknown"] as const;
export const PAYMENT_STATUSES = ["unknown", "channel_collects", "pending", "paid", "partially_refunded", "refunded"] as const;
export const SOURCE_CHANNELS = ["airbnb", "booking_com", "direct", "manual", "import", "other"] as const;

export const BOOKING_STATUS_LABELS: Record<string, string> = { hold: "Giữ chỗ", confirmed: "Đã xác nhận", cancelled: "Đã hủy" };
export const STAY_STATUS_LABELS: Record<string, string> = {
  expected: "Chưa đến",
  checked_in: "Đang ở",
  checked_out: "Đã trả phòng",
  no_show: "Không đến",
  unknown: "Chưa rõ",
};
export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unknown: "Chưa rõ",
  channel_collects: "Kênh thu hộ",
  pending: "Chờ thanh toán",
  paid: "Đã thanh toán",
  partially_refunded: "Hoàn một phần",
  refunded: "Đã hoàn tiền",
};
export const CHANNEL_LABELS: Record<string, string> = {
  airbnb: "Airbnb",
  booking_com: "Booking.com",
  direct: "Trực tiếp",
  manual: "Nhập tay",
  import: "Nhập Excel",
  other: "Khác",
};

export const dateString = z.string().refine(isValidDate, "Ngày không hợp lệ (YYYY-MM-DD)");
const timeString = z.string().regex(/^\d{2}:\d{2}$/, "Giờ dạng HH:MM");
const money = z
  .string()
  .regex(/^\d+([.,]\d{1,2})?$/, "Số tiền dạng 123.45")
  .optional()
  .nullable();

export const guestInput = z.object({
  fullName: z.string().trim().min(1, "Cần tên khách").max(200),
  email: z.string().trim().email("Email không hợp lệ").max(200).optional().nullable().or(z.literal("")),
  phone: z.string().trim().max(50).optional().nullable(),
  language: z.string().trim().max(20).optional().nullable(),
});

export const allocationInput = z.object({
  unitId: z.string().uuid(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  guests: z.number().int().min(0).max(50).optional().nullable(),
});

export const createBookingInput = z
  .object({
    sourceChannel: z.enum(SOURCE_CHANNELS),
    sourceAccount: z.string().trim().max(100).optional().default(""),
    externalRef: z.string().trim().max(100).optional().nullable(),
    guest: guestInput,
    checkInDate: dateString,
    checkOutDate: dateString,
    allocations: z.array(allocationInput).min(1, "Cần ít nhất một phòng"),
    adults: z.number().int().min(0).max(50).optional().nullable(),
    children: z.number().int().min(0).max(50).optional().nullable(),
    etaLocal: timeString.optional().nullable().or(z.literal("")),
    totalAmount: money,
    currency: z.string().length(3).optional().default("EUR"),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional().default("unknown"),
    channelNote: z.string().max(2000).optional().nullable(),
    opsNote: z.string().max(2000).optional().nullable(),
  })
  .refine((v) => v.checkOutDate > v.checkInDate, { message: "Ngày trả phải sau ngày nhận", path: ["checkOutDate"] });
export type CreateBookingInput = z.input<typeof createBookingInput>;

/** Sửa thông tin không ảnh hưởng tồn phòng. Đổi ngày/phòng/số khách đi qua yêu cầu thay đổi. */
export const updateBookingDetailsInput = z.object({
  expectedVersion: z.number().int().positive(),
  guest: guestInput.partial().optional(),
  etaLocal: timeString.optional().nullable().or(z.literal("")),
  totalAmount: money,
  currency: z.string().length(3).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  channelNote: z.string().max(2000).optional().nullable(),
  opsNote: z.string().max(2000).optional().nullable(),
  externalRef: z.string().trim().max(100).optional().nullable(),
});

export const changeRequestInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dates"),
    checkInDate: dateString,
    checkOutDate: dateString,
  }),
  z.object({
    kind: z.literal("move_unit"),
    allocationId: z.string().uuid(),
    toUnitId: z.string().uuid(),
    /** Ngày khách bắt đầu ở phòng mới; bỏ trống = chuyển cả đoạn. */
    effectiveDate: dateString.optional().nullable(),
  }),
  z.object({
    kind: z.literal("guests"),
    adults: z.number().int().min(0).max(50),
    children: z.number().int().min(0).max(50).default(0),
  }),
  z.object({ kind: z.literal("cancel"), reason: z.string().trim().min(3, "Cần lý do hủy").max(500) }),
  z.object({ kind: z.literal("late_checkout"), time: timeString }),
  z.object({ kind: z.literal("early_checkin"), time: timeString }),
]);
export type ChangeRequestPayload = z.infer<typeof changeRequestInput>;

export const CHANGE_KIND_LABELS: Record<string, string> = {
  dates: "Đổi ngày",
  move_unit: "Đổi phòng",
  guests: "Đổi số khách",
  cancel: "Hủy booking",
  late_checkout: "Trả phòng muộn",
  early_checkin: "Nhận phòng sớm",
};
