-- VD Hotel — cột bổ sung theo yêu cầu module manager (Đợt 2)
-- Người tạo mẫu tin: để chặn tự duyệt mẫu của chính mình mà không phải suy từ nhật ký.
ALTER TABLE message_templates ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE message_templates ADD CONSTRAINT message_templates_no_self_approve CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by);

-- Cấp đẩy lên hiện tại của yêu cầu chuyển người (giống tickets.escalation_level).
ALTER TABLE handoffs ADD COLUMN escalation_level int NOT NULL DEFAULT 0;
ALTER TABLE handoffs ADD COLUMN escalated_at timestamptz;
