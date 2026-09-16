-- VD Hotel — thời điểm tin vào hàng đợi gửi lần đầu (hạn gửi tính từ mốc này, không bị dời khi tin phải chờ lượt).
ALTER TABLE messages ADD COLUMN queued_at timestamptz;
