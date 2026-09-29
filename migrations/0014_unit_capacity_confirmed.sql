-- Sức chứa đã được người vận hành xác nhận chưa.
--
-- Trước đây đoán bằng "capacity = 2" vì nhập danh mục để tạm 2 khách/phòng. Khi đội xác nhận phòng ĐÚNG LÀ
-- 2 khách thì cách đoán này vẫn kêu thiếu, nên trợ lý đi giục mãi một việc đã xong. Trạng thái phải ghi rõ,
-- không suy từ giá trị.
ALTER TABLE units ADD COLUMN IF NOT EXISTS capacity_confirmed_at timestamptz;

COMMENT ON COLUMN units.capacity_confirmed_at IS
  'Lúc người vận hành xác nhận sức chứa là số thật. NULL = còn là số tạm lúc nhập danh mục.';
