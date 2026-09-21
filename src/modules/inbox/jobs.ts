import type { PeriodicJob } from "@/worker/registry";
import { runSendQueue } from "./sender";
import { runStaffAssist } from "./staff-assist";

/** Việc nền hộp thư: chỉ worker gửi tin ra WhatsApp (tuần tự, hạn mức theo DB, không tự gửi lại khi không rõ kết quả). */
export const periodic: PeriodicJob[] = [
  {
    // Trợ lý trực nội bộ: trả lời tin của đội. Không đụng hội thoại khách.
    name: "inbox.staff-assist",
    everyMs: 20000,
    run: () => runStaffAssist(),
  },
  {
    name: "inbox.send-queued",
    everyMs: 2000,
    run: () => runSendQueue(),
  },
];
