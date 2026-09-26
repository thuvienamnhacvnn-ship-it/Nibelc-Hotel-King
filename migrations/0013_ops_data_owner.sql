-- Ai là người CUNG CẤP thông tin vận hành, ai chỉ CHỈ ĐẠO.
--
-- Trợ lý từng giao việc "gửi sức chứa phòng", "nhập file Excel" cho người chỉ đạo hệ thống, vì nó chỉ
-- thấy vai (role) chứ không biết ai mới nắm thông tin thực địa. Vai không đủ để suy ra: cùng là admin
-- nhưng một người quản vận hành, một người lo kỹ thuật.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ops_data_owner boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN users.ops_data_owner IS
  'true = có thể được nhờ cung cấp thông tin vận hành (sức chứa, danh sách người dọn, file booking...). false = chỉ chỉ đạo/kỹ thuật, không giao việc nộp thông tin.';
