-- Thư điện tử nhận được ở hộp thư của hệ thống (đặt phòng từ kênh gửi về).
--
-- Vì sao cần: link lịch iCal chỉ nói "đêm này bận", không có tên khách, mã đơn hay số tiền. Kênh lại
-- gửi email xác nhận cho MỖI đơn mới. Nhận và bóc email là đường lấy được đơn tự động mà không cần
-- API đối tác, không phí hằng tháng, không đụng điều khoản của kênh.
CREATE TABLE IF NOT EXISTS inbound_emails (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  -- Message-Id của thư: chống nhập lặp khi worker chạy lại hoặc kênh gửi lại cùng một thư.
  message_id     text NOT NULL,
  from_addr      text NOT NULL,
  to_addr        text NOT NULL,
  subject        text NOT NULL DEFAULT '',
  sent_at        timestamptz,
  -- Phần chữ đã bóc ra khỏi MIME; KHÔNG giữ bản HTML gốc cho nhẹ và đỡ lưu rác.
  body_text      text NOT NULL DEFAULT '',
  -- pending: chưa bóc được thành đơn; parsed: đã tạo/khớp booking; ignored: thư không liên quan;
  -- failed: bóc hỏng, cần người xem.
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','parsed','ignored','failed')),
  detected_kind  text,
  booking_id     uuid REFERENCES bookings(id),
  parse_note     text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  UNIQUE (org_id, message_id)
);

CREATE INDEX IF NOT EXISTS inbound_emails_status_idx ON inbound_emails (org_id, status, received_at);

COMMENT ON TABLE inbound_emails IS
  'Thư kênh gửi về hộp datphong@vietduc-hub.com. Giữ lại cả thư chưa bóc được để còn viết bộ bóc theo mẫu thật.';
