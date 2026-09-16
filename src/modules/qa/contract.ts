/**
 * HỢP ĐỒNG DÙNG CHUNG giữa module Q&A (sở hữu cách tra cứu) và module hộp thư (dùng kết quả để soạn nháp).
 * Quy tắc: chỉ trả câu trả lời status='approved', còn hiệu lực theo ngày Budapest, đúng phạm vi
 * (phòng → nhà → chung, ưu tiên hẹp nhất). Không có căn cứ ⇒ trả null — hộp thư phải chuyển người, không đoán.
 */
export interface GroundedAnswer {
  entryId: string;
  entryKey: string;
  version: number;
  scope: "general" | "property" | "unit";
  topic: string;
  answer: string;
  language: "en" | "vi";
  sensitivity: "public" | "restricted" | "handoff";
  /** 0..1 — độ khớp theo từ khoá, KHÔNG phải xác suất của mô hình */
  score: number;
}

export interface GroundingQuery {
  orgId: string;
  text: string;
  unitId?: string | null;
  propertyId?: string | null;
  /** Khách đã khớp booking chưa — mục 'restricted' chỉ dùng khi đã khớp */
  verification: "none" | "matched" | "verified";
  language?: "en" | "vi";
  opsDate: string;
}

export type FindGroundedAnswer = (q: GroundingQuery) => Promise<GroundedAnswer | null>;
