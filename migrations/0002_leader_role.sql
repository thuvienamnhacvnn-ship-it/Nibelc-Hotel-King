-- Vai trò Leader (16/09/2026): Ngọc là Leader chính, anh Nguyên là Sếp tổng.
-- Leader xem và duyệt được mọi nghiệp vụ, là cấp cao nhất nhận việc bị đẩy lên.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','leader','vn_manager','vn_staff','bp_coordinator','bp_staff','cleaner','manager_viewer'));

-- Người phụ trách thêm mảng ngoài vai trò chính (ví dụ Thảo kiêm đầu mối sửa chữa/bảo trì).
ALTER TABLE users ADD COLUMN duties text[] NOT NULL DEFAULT '{}';
