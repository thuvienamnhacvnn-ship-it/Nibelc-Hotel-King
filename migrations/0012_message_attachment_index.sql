-- Soát tệp gửi trùng: tìm theo mã băm nội dung bằng phép chứa jsonb (`attachments @> '[{"sha256": ...}]'`).
-- Không có chỉ mục thì mỗi tệp gửi vào phải quét toàn bảng messages.
CREATE INDEX IF NOT EXISTS messages_attachments_gin ON messages USING gin (attachments jsonb_path_ops);
