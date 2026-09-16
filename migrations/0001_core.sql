-- NIBELC Platform — lõi dữ liệu Đợt 1
-- Một người sở hữu schema/migration. Không sửa file đã áp; thêm migration mới.
--
-- Quy ước:
--   * Mọi bảng nghiệp vụ có org_id; mọi truy vấn phải lọc theo org_id của phiên.
--   * Thời điểm lưu timestamptz (UTC). Ngày vận hành (ngày ở) lưu kiểu date theo giờ Budapest của nhà.
--   * Tiền lưu bigint theo đơn vị nhỏ nhất (cent) + mã tiền tệ. Không dùng float.
--   * is_demo = true đánh dấu dữ liệu mẫu, giao diện luôn hiện nhãn DEMO.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────────────────────── Tổ chức, người dùng, phiên ─────────────────────────

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Europe/Budapest',
  currency      char(3) NOT NULL DEFAULT 'EUR',
  locale        text NOT NULL DEFAULT 'vi',
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  email           text NOT NULL,
  full_name       text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','vn_manager','vn_staff','bp_coordinator','bp_staff','cleaner','manager_viewer')),
  password_hash   text NOT NULL,
  locale          text NOT NULL DEFAULT 'vi',
  phone           text,
  active          boolean NOT NULL DEFAULT true,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Email duy nhất toàn hệ thống: đăng nhập không cần chọn tổ chức.
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text,
  ip            text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ───────────────────────── Danh mục nhà / tài nguyên / sản phẩm ─────────────────────────

CREATE TABLE properties (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  code               text NOT NULL,
  name               text NOT NULL,
  address            text,
  timezone           text NOT NULL DEFAULT 'Europe/Budapest',
  check_in_from      time NOT NULL DEFAULT '15:00',
  check_in_until     time NOT NULL DEFAULT '23:00',
  check_out_at       time NOT NULL DEFAULT '10:00',
  default_clean_minutes int NOT NULL DEFAULT 90 CHECK (default_clean_minutes > 0),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','historical')),
  data_status        text NOT NULL DEFAULT 'needs_confirmation' CHECK (data_status IN ('confirmed','needs_confirmation')),
  data_note          text,
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

-- Tài nguyên vật lý nhỏ nhất bị chiếm khi có khách (một phòng ngủ, một studio).
-- Chống trùng được thực hiện trên tài nguyên, không trên sản phẩm bán.
CREATE TABLE resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  property_id  uuid NOT NULL REFERENCES properties(id),
  code         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'room' CHECK (kind IN ('room','studio','shared_area')),
  active       boolean NOT NULL DEFAULT true,
  is_demo      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);
CREATE INDEX resources_property_idx ON resources (property_id);

-- Sản phẩm bán (nguyên căn, phòng lẻ, studio). Mã chuẩn = mã trong file Vietnam Team (5000, 5001, U000...).
CREATE TABLE units (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  property_id      uuid NOT NULL REFERENCES properties(id),
  code             text NOT NULL,
  name             text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('whole','room','studio')),
  capacity         int NOT NULL CHECK (capacity > 0),
  bed_config       text,
  clean_minutes    int CHECK (clean_minutes IS NULL OR clean_minutes > 0),
  active           boolean NOT NULL DEFAULT true,
  data_status      text NOT NULL DEFAULT 'needs_confirmation' CHECK (data_status IN ('confirmed','needs_confirmation')),
  data_note        text,
  sort_order       int NOT NULL DEFAULT 0,
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);
CREATE INDEX units_property_idx ON units (property_id);

-- Quan hệ nguyên căn ↔ phòng lẻ khai báo tường minh bằng tài nguyên dùng chung.
-- Nguyên căn gắn mọi phòng; phòng lẻ gắn đúng phòng của nó.
CREATE TABLE unit_resources (
  unit_id      uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  resource_id  uuid NOT NULL REFERENCES resources(id),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  PRIMARY KEY (unit_id, resource_id)
);
CREATE INDEX unit_resources_resource_idx ON unit_resources (resource_id);

-- Tên gọi khác trong Excel/tin nhắn ("Baby Room J50", "Sweet Home Jozsef krt50") trỏ về mã chuẩn.
CREATE TABLE unit_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  unit_id     uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  alias_norm  text NOT NULL,
  alias_raw   text NOT NULL,
  source      text NOT NULL DEFAULT 'manual',
  UNIQUE (org_id, alias_norm)
);

-- Listing theo kênh. Không lưu mật khẩu; account_label chỉ là nhãn nhận diện tài khoản.
CREATE TABLE channel_listings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  unit_id              uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  channel              text NOT NULL CHECK (channel IN ('airbnb','booking_com','direct','other')),
  account_label        text,
  listing_name         text,
  external_listing_id  text,
  external_room_id     text,
  capacity_on_channel  int,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked_by_platform','inactive','unknown')),
  data_status          text NOT NULL DEFAULT 'needs_confirmation' CHECK (data_status IN ('confirmed','needs_confirmation')),
  data_note            text,
  is_demo              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_listings_unit_idx ON channel_listings (unit_id);

-- ───────────────────────── Khách và booking ─────────────────────────

CREATE TABLE guests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  full_name   text NOT NULL,
  email       text,
  phone       text,
  language    text,
  is_demo     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  -- Khoá nguồn: kênh + tài khoản/property + mã booking của kênh
  source_channel       text NOT NULL CHECK (source_channel IN ('airbnb','booking_com','direct','manual','import','other')),
  source_account       text NOT NULL DEFAULT '',
  external_ref         text,
  guest_id             uuid REFERENCES guests(id),
  -- Bốn trạng thái tách riêng
  booking_status       text NOT NULL DEFAULT 'confirmed' CHECK (booking_status IN ('hold','confirmed','cancelled')),
  stay_status          text NOT NULL DEFAULT 'expected' CHECK (stay_status IN ('expected','checked_in','checked_out','no_show','unknown')),
  payment_status       text NOT NULL DEFAULT 'unknown' CHECK (payment_status IN ('unknown','channel_collects','pending','paid','partially_refunded','refunded')),
  check_in_date        date NOT NULL,
  check_out_date       date NOT NULL,
  adults               int CHECK (adults IS NULL OR adults >= 0),
  children             int CHECK (children IS NULL OR children >= 0),
  total_guests         int CHECK (total_guests IS NULL OR total_guests >= 0),
  eta_local            text,
  early_checkin_time   time,
  late_checkout_time   time,
  actual_check_in_at   timestamptz,
  actual_check_out_at  timestamptz,
  total_amount_minor   bigint CHECK (total_amount_minor IS NULL OR total_amount_minor >= 0),
  currency             char(3) NOT NULL DEFAULT 'EUR',
  booking_created_at   timestamptz,
  channel_note         text,
  ops_note             text,
  hold_expires_at      timestamptz,
  version              int NOT NULL DEFAULT 1,
  source_version       bigint,
  source_updated_at    timestamptz,
  last_synced_at       timestamptz,
  created_by           uuid REFERENCES users(id),
  is_demo              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out_date > check_in_date)
);
CREATE UNIQUE INDEX bookings_source_uq ON bookings (org_id, source_channel, source_account, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX bookings_dates_idx ON bookings (org_id, check_in_date, check_out_date);

-- Phân bổ phòng theo thời gian. Một booking có nhiều dòng (nhiều phòng, hoặc đổi phòng giữa kỳ).
CREATE TABLE booking_allocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  unit_id       uuid NOT NULL REFERENCES units(id),
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  guests        int,
  -- active: đang giữ tồn; released: đã giải phóng (hủy/đổi); conflict: nguồn ngoài báo booking nhưng tồn đã bị chiếm
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','conflict')),
  replaced_by   uuid REFERENCES booking_allocations(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  CHECK (end_date > start_date)
);
CREATE INDEX booking_allocations_booking_idx ON booking_allocations (booking_id);
CREATE INDEX booking_allocations_unit_idx ON booking_allocations (unit_id, start_date, end_date);

-- Chặn tồn thủ công (bảo trì, chủ nhà dùng, khoá do sự cố)
CREATE TABLE inventory_blocks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  unit_id      uuid NOT NULL REFERENCES units(id),
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  reason       text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  CHECK (end_date > start_date)
);

-- Chiếm tài nguyên theo đêm. Ràng buộc EXCLUDE là chốt cuối chống trùng — kể cả khi hai giao dịch chạy cùng lúc.
CREATE TABLE resource_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  resource_id    uuid NOT NULL REFERENCES resources(id),
  allocation_id  uuid REFERENCES booking_allocations(id) ON DELETE CASCADE,
  block_id       uuid REFERENCES inventory_blocks(id) ON DELETE CASCADE,
  stay           daterange NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((allocation_id IS NULL) <> (block_id IS NULL)),
  CONSTRAINT resource_claims_no_overlap EXCLUDE USING gist (resource_id WITH =, stay WITH &&) WHERE (active)
);
CREATE INDEX resource_claims_allocation_idx ON resource_claims (allocation_id);

-- Lịch sử thay đổi booking (trước/sau, ai, nguồn nào)
CREATE TABLE booking_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  version       int NOT NULL,
  change_type   text NOT NULL,
  before        jsonb,
  after         jsonb,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','system','connector','import','agent')),
  actor_id      uuid,
  source        text,
  source_ref    text,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_changes_booking_idx ON booking_changes (booking_id, created_at);

-- Yêu cầu thay đổi đang chờ — tách khỏi thay đổi đã xác nhận
CREATE TABLE change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  booking_id        uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  booking_version   int NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('dates','move_unit','guests','cancel','late_checkout','early_checkin')),
  payload           jsonb NOT NULL,
  source            text NOT NULL CHECK (source IN ('staff','guest_message','connector','agent')),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','superseded','failed')),
  note              text,
  check_result      jsonb,
  requested_by      uuid REFERENCES users(id),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_requests_status_idx ON change_requests (org_id, status, created_at);

-- Xung đột tồn cần người xử lý (hai nguồn ngoài cùng bán một đêm)
CREATE TABLE inventory_conflicts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  allocation_id  uuid REFERENCES booking_allocations(id) ON DELETE CASCADE,
  unit_id        uuid NOT NULL REFERENCES units(id),
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  detail         jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by    uuid REFERENCES users(id),
  resolved_at    timestamptz,
  resolution     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Kết nối, sự kiện, outbox ─────────────────────────

CREATE TABLE connector_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  channel          text NOT NULL,
  label            text NOT NULL,
  -- Trạng thái theo đặc tả: chưa cấu hình, demo, thử nghiệm, hoạt động, lỗi
  status           text NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured','demo','testing','active','error')),
  capabilities     jsonb NOT NULL DEFAULT '{}'::jsonb,
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_attempt_at  timestamptz,
  last_success_at  timestamptz,
  last_error       text,
  paused           boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, channel, label)
);

-- Sự kiện nhận từ nguồn — lưu bền trước khi xử lý; chống trùng theo (connector, external_event_id)
CREATE TABLE inbound_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  connector_id         uuid NOT NULL REFERENCES connector_accounts(id),
  external_event_id    text NOT NULL,
  external_ref         text,
  event_type           text NOT NULL,
  source_version       bigint,
  source_occurred_at   timestamptz,
  payload              jsonb NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL DEFAULT 'received' CHECK (status IN ('received','applied','duplicate','stale','needs_reconcile','conflict','failed')),
  result               jsonb,
  booking_id           uuid REFERENCES bookings(id),
  processed_at         timestamptz,
  UNIQUE (connector_id, external_event_id)
);

CREATE TABLE outbox_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  topic              text NOT NULL,
  aggregate_type     text NOT NULL,
  aggregate_id       uuid NOT NULL,
  aggregate_version  int,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key         text UNIQUE,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts           int NOT NULL DEFAULT 0,
  max_attempts       int NOT NULL DEFAULT 5,
  available_at       timestamptz NOT NULL DEFAULT now(),
  locked_until       timestamptz,
  locked_by          text,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events (status, available_at);

-- ───────────────────────── Cleaning ─────────────────────────

CREATE TABLE cleaner_profiles (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id             uuid NOT NULL REFERENCES organizations(id),
  max_tasks_per_day  int NOT NULL DEFAULT 6,
  skills             text[] NOT NULL DEFAULT '{}',
  preferred_property_ids uuid[] NOT NULL DEFAULT '{}',
  active             boolean NOT NULL DEFAULT true,
  note               text,
  is_demo            boolean NOT NULL DEFAULT false
);

CREATE TABLE cleaner_shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date   date NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  is_demo     boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, work_date, start_time)
);

CREATE TABLE checklist_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  property_id  uuid REFERENCES properties(id),
  task_kind    text NOT NULL DEFAULT 'turnover',
  name         text NOT NULL,
  items        jsonb NOT NULL,
  version      int NOT NULL DEFAULT 1,
  active       boolean NOT NULL DEFAULT true,
  is_demo      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cleaning_tasks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  property_id            uuid NOT NULL REFERENCES properties(id),
  unit_id                uuid NOT NULL REFERENCES units(id),
  kind                   text NOT NULL CHECK (kind IN ('turnover','departure','stayover','shared_area','reclean','manual')),
  status                 text NOT NULL DEFAULT 'pending_assignment' CHECK (status IN ('pending_assignment','assigned','accepted','in_progress','awaiting_inspection','needs_reclean','passed','cancelled')),
  service_date           date NOT NULL,
  earliest_start_at      timestamptz,
  due_at                 timestamptz NOT NULL,
  estimated_minutes      int NOT NULL DEFAULT 90,
  departing_allocation_id uuid REFERENCES booking_allocations(id) ON DELETE SET NULL,
  departing_booking_id   uuid REFERENCES bookings(id) ON DELETE SET NULL,
  arriving_booking_id    uuid REFERENCES bookings(id) ON DELETE SET NULL,
  booking_version_seen   int,
  assigned_to            uuid REFERENCES users(id),
  assigned_at            timestamptz,
  accepted_at            timestamptz,
  started_at             timestamptz,
  finished_at            timestamptz,
  -- Thay đổi xảy ra khi việc đã nhận/đang làm: cleaner/điều phối phải xác nhận
  pending_change         jsonb,
  change_ack_required    boolean NOT NULL DEFAULT false,
  priority               int NOT NULL DEFAULT 0,
  note                   text,
  dedupe_key             text NOT NULL,
  checklist_template_id  uuid REFERENCES checklist_templates(id),
  version                int NOT NULL DEFAULT 1,
  is_demo                boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, dedupe_key)
);
CREATE INDEX cleaning_tasks_date_idx ON cleaning_tasks (org_id, service_date);
CREATE INDEX cleaning_tasks_assignee_idx ON cleaning_tasks (assigned_to, service_date);

CREATE TABLE cleaning_task_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  task_id     uuid NOT NULL REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  from_status text,
  to_status   text,
  detail      jsonb,
  actor_type  text NOT NULL,
  actor_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cleaning_task_events_task_idx ON cleaning_task_events (task_id, created_at);

CREATE TABLE task_checklist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  task_id      uuid NOT NULL REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  item_key     text NOT NULL,
  label        text NOT NULL,
  category     text,
  requires_photo boolean NOT NULL DEFAULT false,
  sort_order   int NOT NULL DEFAULT 0,
  checked      boolean NOT NULL DEFAULT false,
  checked_by   uuid REFERENCES users(id),
  checked_at   timestamptz,
  note         text,
  UNIQUE (task_id, item_key)
);

CREATE TABLE task_incidents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  task_id      uuid REFERENCES cleaning_tasks(id) ON DELETE SET NULL,
  unit_id      uuid NOT NULL REFERENCES units(id),
  kind         text NOT NULL CHECK (kind IN ('maintenance','missing_supplies','damage','guest_still_inside','access','other')),
  severity     text NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','blocking')),
  description  text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  reported_by  uuid REFERENCES users(id),
  resolved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

-- Trạng thái vật lý theo phòng — tách khỏi lịch bán. Sản phẩm (nguyên căn/phòng lẻ) lấy trạng thái xấu nhất của các phòng.
CREATE TABLE resource_readiness (
  resource_id  uuid PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  status       text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','occupied','vacated_dirty','cleaning','inspection_pending','ready','out_of_service')),
  task_id      uuid REFERENCES cleaning_tasks(id) ON DELETE SET NULL,
  decided_by   uuid REFERENCES users(id),
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Nhập Excel ─────────────────────────

CREATE TABLE import_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  file_name    text NOT NULL,
  file_sha256  text NOT NULL,
  status       text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','applied','discarded')),
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
  options      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  applied_by   uuid REFERENCES users(id),
  applied_at   timestamptz
);
-- Một file đã áp dụng thì không áp dụng lần nữa
CREATE UNIQUE INDEX import_batches_applied_uq ON import_batches (org_id, file_sha256) WHERE status = 'applied';

CREATE TABLE import_rows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  batch_id     uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  sheet        text NOT NULL,
  row_number   int NOT NULL,
  raw          jsonb NOT NULL,
  parsed       jsonb,
  issues       jsonb NOT NULL DEFAULT '[]'::jsonb,
  disposition  text NOT NULL CHECK (disposition IN ('ready','needs_review','duplicate_in_file','already_imported','skipped','applied','error')),
  source_key   text,
  booking_id   uuid REFERENCES bookings(id),
  UNIQUE (batch_id, sheet, row_number)
);
CREATE INDEX import_rows_batch_idx ON import_rows (batch_id, disposition);

-- ───────────────────────── Duyệt và nhật ký ─────────────────────────

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  actor_type    text NOT NULL,
  actor_id      uuid,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  detail        jsonb,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (org_id, entity_type, entity_id);
CREATE INDEX audit_log_created_idx ON audit_log (org_id, created_at DESC);

CREATE TABLE automation_switches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  scope       text NOT NULL CHECK (scope IN ('org','agent','channel')),
  scope_key   text NOT NULL DEFAULT '',
  paused      boolean NOT NULL DEFAULT false,
  reason      text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope, scope_key)
);

-- Nhịp sống tiến trình nền (worker, scheduler) — để giao diện biết worker có đang chạy không
CREATE TABLE system_heartbeats (
  name          text PRIMARY KEY,
  last_beat_at  timestamptz NOT NULL DEFAULT now(),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
