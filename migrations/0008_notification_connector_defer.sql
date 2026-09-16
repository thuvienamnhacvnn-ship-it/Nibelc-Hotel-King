-- VD Hotel — sửa QA2 đường gửi WhatsApp
-- Thông báo đội ghi connector đã/sẽ dùng để gửi ⇒ đếm hạn mức theo giờ chung với tin hộp thư trên cùng một số.
ALTER TABLE staff_notifications ADD COLUMN connector_id uuid REFERENCES connector_accounts(id);
-- Vượt hạn mức thì hoãn tới available_at thay vì huỷ vĩnh viễn.
ALTER TABLE staff_notifications ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE messages ADD COLUMN available_at timestamptz;
CREATE INDEX staff_notifications_connector_sent_idx ON staff_notifications (connector_id, sent_at) WHERE status IN ('sent','sending');
CREATE INDEX messages_connector_sent_idx ON messages (connector_id, sent_at) WHERE direction = 'out' AND status IN ('sent','sending');
