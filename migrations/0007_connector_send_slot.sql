-- VD Hotel — mốc gửi tin gần nhất của mỗi connector (hạn mức ≥3 giây/tin, dùng chung cho tin khách và thông báo đội).
-- Tách khỏi last_attempt_at (cột đó thuộc bộ nhận sự kiện kênh).
ALTER TABLE connector_accounts ADD COLUMN last_send_at timestamptz;
