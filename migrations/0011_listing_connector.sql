-- Gắn listing với TÀI KHOẢN kênh (công ty có 5 tài khoản trên Airbnb/Booking.com).
-- Chỉ thêm cột, không bắt buộc, không đụng dữ liệu cũ; chạy lại hai lần vẫn an toàn.
ALTER TABLE channel_listings ADD COLUMN IF NOT EXISTS connector_id uuid REFERENCES connector_accounts(id);

CREATE INDEX IF NOT EXISTS channel_listings_connector_idx ON channel_listings (connector_id);

COMMENT ON COLUMN channel_listings.connector_id IS
  'Tài khoản kênh đang bán listing này. NULL = chưa biết (dữ liệu nhập trước khi có nhiều tài khoản).';
