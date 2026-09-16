import type { PeriodicJob } from "@/worker/registry";
import { runSendQueue } from "./sender";

/** Việc nền hộp thư: chỉ worker gửi tin ra WhatsApp (tuần tự, hạn mức theo DB, không tự gửi lại khi không rõ kết quả). */
export const periodic: PeriodicJob[] = [
  {
    name: "inbox.send-queued",
    everyMs: 2000,
    run: () => runSendQueue(),
  },
];
