import type { PeriodicJob } from "@/worker/registry";
import { runMailIntake } from "./service";

/**
 * Quét hộp thư mỗi phút. Kênh gửi thư xác nhận ngay khi có đơn mới, nên một phút là đủ nhanh
 * mà vẫn nhẹ: không có thư thì chỉ là một lần đọc thư mục rỗng.
 */
export const periodic: PeriodicJob[] = [
  {
    name: "mail-intake",
    everyMs: 60_000,
    run: () => runMailIntake(),
  },
];
