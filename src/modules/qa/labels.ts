/** Nhãn hiển thị Kho Q&A — không phụ thuộc DB nên dùng được cả trong Client Component. */

export const QA_SCOPES = ["general", "property", "unit"] as const;
export const QA_STATUSES = ["draft", "pending_review", "approved", "retired"] as const;
export const QA_SENSITIVITIES = ["public", "restricted", "handoff"] as const;

export const QA_STATUS_LABELS: Record<string, string> = {
  draft: "Nháp",
  pending_review: "Chờ duyệt",
  approved: "Đã duyệt",
  retired: "Ngưng dùng",
};
export const QA_SCOPE_LABELS: Record<string, string> = { general: "Chung", property: "Theo nhà", unit: "Theo phòng" };
export const QA_SENSITIVITY_LABELS: Record<string, string> = {
  public: "Công khai",
  restricted: "Chỉ khách đã khớp booking",
  handoff: "Luôn chuyển người",
};
export const QA_AUDIT_LABELS: Record<string, string> = {
  "qa.create": "Tạo nháp",
  "qa.update": "Sửa nội dung",
  "qa.revise": "Tạo phiên bản mới",
  "qa.submit": "Gửi duyệt",
  "qa.approve": "Duyệt",
  "qa.reject": "Từ chối",
  "qa.retire": "Ngưng dùng",
};

export const qaStatusTone = (status: string) => (status === "approved" ? "ok" : status === "pending_review" ? "warn" : status === "retired" ? "neutral" : "info");
export const qaSensitivityTone = (s: string) => (s === "handoff" ? "danger" : s === "restricted" ? "warn" : "neutral");
