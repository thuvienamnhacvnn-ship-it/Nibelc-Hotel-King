-- VD Hotel — connector iCal CHỈ ĐỌC: đối chiếu lịch bận trên kênh (Airbnb/Booking.com) với tồn phòng trong hệ thống.
-- iCal chỉ có bận/trống: không tên khách, không số khách, không tin nhắn, không realtime (Airbnb làm mới ~3 giờ).

-- Link xuất lịch của kênh có token bí mật: lưu riêng, giao diện chỉ hiện dạng che.
CREATE TABLE ical_feeds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  listing_id         uuid NOT NULL REFERENCES channel_listings(id) ON DELETE CASCADE,
  url_secret         text NOT NULL,
  url_hint           text NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  poll_minutes       int NOT NULL DEFAULT 30 CHECK (poll_minutes >= 15),
  last_attempt_at    timestamptz,
  last_success_at    timestamptz,
  last_error         text,
  last_event_count   int,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, listing_id)
);

-- Kết quả đối chiếu. Không tự sửa booking — chỉ mở phát hiện cho người xử lý.
CREATE TABLE calendar_sync_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  feed_id         uuid NOT NULL REFERENCES ical_feeds(id) ON DELETE CASCADE,
  unit_id         uuid NOT NULL REFERENCES units(id),
  -- channel_busy_not_in_system: kênh bận mà hệ thống không có booking/chặn tồn (có thể sót booking)
  -- system_busy_channel_free: hệ thống có booking mà kênh vẫn trống (kênh chưa đóng bán — nguy cơ bán trùng)
  kind            text NOT NULL CHECK (kind IN ('channel_busy_not_in_system','system_busy_channel_free')),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id),
  resolution      text,
  CHECK (end_date > start_date)
);
CREATE UNIQUE INDEX calendar_sync_findings_open_uq ON calendar_sync_findings (feed_id, kind, start_date, end_date) WHERE status = 'open';
