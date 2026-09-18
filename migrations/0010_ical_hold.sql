-- VD Hotel — "giữ chỗ theo lịch kênh": lịch bận đọc từ iCal được phép tạo CHẶN TỒN cho đúng phòng của link.
-- Vẫn KHÔNG bao giờ tạo/sửa/huỷ booking của khách: iCal không có tên khách, số khách, giá — chỉ có ngày bận.
-- Mặc định tắt ⇒ link cũ giữ nguyên hành vi chỉ đọc + ghi phát hiện lệch.
ALTER TABLE ical_feeds ADD COLUMN IF NOT EXISTS hold_mode text NOT NULL DEFAULT 'off' CHECK (hold_mode IN ('off','block'));

-- Nguồn của chặn tồn: 'manual' = người tạo tay (đồng bộ iCal không bao giờ đụng tới), 'ical' = sinh từ lịch kênh.
ALTER TABLE inventory_blocks ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ical'));
-- Mã sự kiện (UID) của lịch kênh + khoảng ngày ⇒ lần đồng bộ sau nhận lại đúng chặn cũ thay vì tạo thêm.
ALTER TABLE inventory_blocks ADD COLUMN IF NOT EXISTS source_ref text;
-- Xoá link ⇒ xoá luôn chặn do link đó sinh ra (resource_claims cũng xoá theo block_id) — không để lại chặn vô chủ.
ALTER TABLE inventory_blocks ADD COLUMN IF NOT EXISTS ical_feed_id uuid REFERENCES ical_feeds(id) ON DELETE CASCADE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_blocks_source_ck') THEN
    ALTER TABLE inventory_blocks ADD CONSTRAINT inventory_blocks_source_ck CHECK ((source = 'ical') = (ical_feed_id IS NOT NULL));
  END IF;
END $$;

-- Mỗi (link, sự kiện, khoảng ngày) chỉ có một chặn đang hiệu lực — chạy lại feed không nhân đôi chặn.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_blocks_ical_uq ON inventory_blocks (ical_feed_id, source_ref, start_date, end_date) WHERE active AND source = 'ical';
CREATE INDEX IF NOT EXISTS inventory_blocks_ical_feed_idx ON inventory_blocks (ical_feed_id) WHERE active AND source = 'ical';
