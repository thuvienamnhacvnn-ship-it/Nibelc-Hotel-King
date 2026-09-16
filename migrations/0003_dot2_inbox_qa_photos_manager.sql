-- VD Hotel — Đợt 2: hộp thư & tổng đài, kho Q&A, ảnh & kiểm phòng, Agent Manager, thông báo cho đội.
-- Quy ước giữ nguyên Đợt 1: org_id ở mọi bảng, thời điểm UTC, chống trùng bằng khoá DB, không lưu bí mật.

-- ───────────────────────── Hộp thư hợp nhất ─────────────────────────

CREATE TABLE conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  channel              text NOT NULL CHECK (channel IN ('whatsapp','viber','webapp','airbnb','booking_com','internal')),
  connector_id         uuid REFERENCES connector_accounts(id),
  -- Mã luồng của kênh (WhatsApp: remoteJid). Cùng kênh + connector + mã luồng = một hội thoại.
  external_thread_id   text NOT NULL,
  kind                 text NOT NULL DEFAULT 'guest' CHECK (kind IN ('guest','staff','group','unknown')),
  title                text,
  contact_name         text,
  contact_handle       text,
  -- Nhân viên nội bộ nhắn vào tổng đài thì gắn user
  staff_user_id        uuid REFERENCES users(id),
  booking_id           uuid REFERENCES bookings(id),
  unit_id              uuid REFERENCES units(id),
  -- Mức xác minh khách: none (chưa biết), matched (khớp mã + tên + ngày), verified (xác thực bổ sung cho thao tác nhạy cảm)
  verification_level   text NOT NULL DEFAULT 'none' CHECK (verification_level IN ('none','matched','verified')),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting_guest','closed')),
  -- Ai đang cầm hội thoại: bot tự trả lời Q&A đã duyệt, hay người thật (bot im lặng)
  handled_by           text NOT NULL DEFAULT 'human' CHECK (handled_by IN ('bot','human')),
  assignee_user_id     uuid REFERENCES users(id),
  takeover_by          uuid REFERENCES users(id),
  takeover_at          timestamptz,
  language             text,
  last_message_at      timestamptz,
  last_inbound_at      timestamptz,
  unread_count         int NOT NULL DEFAULT 0,
  is_demo              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, channel, connector_id, external_thread_id)
);
CREATE INDEX conversations_inbox_idx ON conversations (org_id, status, last_message_at DESC);

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction            text NOT NULL CHECK (direction IN ('in','out','note')),
  author_type          text NOT NULL CHECK (author_type IN ('guest','staff','bot','system')),
  author_user_id       uuid REFERENCES users(id),
  author_name          text,
  -- Mã tin của kênh — chống lưu trùng khi webhook gửi lại
  external_message_id  text,
  body                 text,
  attachments          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- draft: bot/nhân viên soạn chưa gửi; pending_approval: chờ người duyệt; queued → sent → delivered → read; failed
  status               text NOT NULL DEFAULT 'received' CHECK (status IN ('received','draft','pending_approval','queued','sent','delivered','read','failed','discarded')),
  -- Căn cứ của câu trả lời bot (id Q&A + phiên bản) — không có căn cứ thì không được gửi tự động
  grounding            jsonb,
  approved_by          uuid REFERENCES users(id),
  error                text,
  source_occurred_at   timestamptz,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_external_uq ON messages (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

-- Ticket: yêu cầu cần người xử lý (sự cố, gia hạn, khiếu nại...). P0 nguy hiểm, P1 khẩn (nhận trong 5 phút), P2 thường.
CREATE TABLE tickets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  conversation_id      uuid REFERENCES conversations(id) ON DELETE SET NULL,
  booking_id           uuid REFERENCES bookings(id),
  unit_id              uuid REFERENCES units(id),
  category             text NOT NULL CHECK (category IN ('access','maintenance','cleaning','amenities','booking_change','payment_refund','complaint','question','other')),
  priority             text NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2')),
  status               text NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','accepted','in_progress','awaiting_guest','awaiting_vendor','resolved','verified','closed')),
  summary              text NOT NULL,
  detail               text,
  assignee_user_id     uuid REFERENCES users(id),
  accept_due_at        timestamptz,
  accepted_at          timestamptz,
  escalation_level     int NOT NULL DEFAULT 0,
  escalated_at         timestamptz,
  resolved_at          timestamptz,
  created_by_type      text NOT NULL DEFAULT 'user' CHECK (created_by_type IN ('user','bot','system')),
  created_by           uuid REFERENCES users(id),
  version              int NOT NULL DEFAULT 1,
  is_demo              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_open_idx ON tickets (org_id, status, priority, accept_due_at);

-- Chuyển người thật: chỉ ghi "đã kết nối" khi người nhận bấm nhận
CREATE TABLE handoffs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id            uuid REFERENCES tickets(id) ON DELETE SET NULL,
  reason               text NOT NULL,
  context              jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_user_id       uuid REFERENCES users(id),
  status               text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','escalated','callback','cancelled')),
  requested_at         timestamptz NOT NULL DEFAULT now(),
  accept_due_at        timestamptz,
  accepted_by          uuid REFERENCES users(id),
  accepted_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Người trực và thứ tự đẩy lên (Thảo → trực thay → Leader)
CREATE TABLE escalation_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  purpose       text NOT NULL CHECK (purpose IN ('guest_support','maintenance','cleaning','booking','finance','technical','management')),
  level         int NOT NULL CHECK (level >= 0),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, purpose, level, user_id)
);

-- ───────────────────────── Kho Q&A ─────────────────────────

CREATE TABLE qa_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  -- Nhóm các phiên bản của cùng một câu hỏi
  entry_key            uuid NOT NULL DEFAULT gen_random_uuid(),
  version              int NOT NULL DEFAULT 1,
  scope                text NOT NULL CHECK (scope IN ('general','property','unit')),
  property_id          uuid REFERENCES properties(id),
  unit_id              uuid REFERENCES units(id),
  topic                text NOT NULL,
  question             text NOT NULL,
  variants             text[] NOT NULL DEFAULT '{}',
  answer_en            text NOT NULL,
  answer_vi            text,
  -- restricted: chỉ trả lời khi khách đã khớp booking; handoff: luôn chuyển người
  sensitivity          text NOT NULL DEFAULT 'public' CHECK (sensitivity IN ('public','restricted','handoff')),
  handoff_condition    text,
  source               text,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','approved','retired')),
  valid_from           date,
  valid_to             date,
  created_by           uuid REFERENCES users(id),
  approved_by          uuid REFERENCES users(id),
  approved_at          timestamptz,
  is_demo              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entry_key, version),
  CHECK ((scope = 'general' AND property_id IS NULL AND unit_id IS NULL)
      OR (scope = 'property' AND property_id IS NOT NULL AND unit_id IS NULL)
      OR (scope = 'unit' AND unit_id IS NOT NULL)),
  -- Người tạo không tự duyệt câu trả lời của mình
  CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by)
);
-- Mỗi câu hỏi chỉ có một phiên bản đang được duyệt
CREATE UNIQUE INDEX qa_entries_one_approved_uq ON qa_entries (org_id, entry_key) WHERE status = 'approved';
CREATE INDEX qa_entries_lookup_idx ON qa_entries (org_id, status, scope, property_id, unit_id);

-- ───────────────────────── Ảnh bằng chứng & kiểm phòng ─────────────────────────

CREATE TABLE task_photos (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  task_id              uuid NOT NULL REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  checklist_item_id    uuid REFERENCES task_checklist_items(id) ON DELETE SET NULL,
  unit_id              uuid NOT NULL REFERENCES units(id),
  category             text,
  storage_key          text NOT NULL,
  mime_type            text NOT NULL,
  bytes                int NOT NULL CHECK (bytes > 0),
  width                int,
  height               int,
  sha256               text NOT NULL,
  -- Mã do máy cleaner sinh khi chụp — gửi lại lúc mất mạng không tạo ảnh trùng
  client_upload_id     text NOT NULL,
  client_captured_at   timestamptz,
  uploaded_by          uuid NOT NULL REFERENCES users(id),
  received_at          timestamptz NOT NULL DEFAULT now(),
  flags                text[] NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','rejected','replaced')),
  UNIQUE (org_id, uploaded_by, client_upload_id)
);
CREATE INDEX task_photos_task_idx ON task_photos (task_id);
CREATE INDEX task_photos_sha_idx ON task_photos (org_id, sha256);

-- Kết quả kiểm theo từng mục: thấy đạt / thấy lỗi / không đủ bằng chứng. Người hay AI đều ghi ở đây.
CREATE TABLE qc_reviews (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  task_id              uuid NOT NULL REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  reviewer_type        text NOT NULL CHECK (reviewer_type IN ('ai','human','rules')),
  reviewer_user_id     uuid REFERENCES users(id),
  model                text,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','not_configured')),
  items                jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary              text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);
CREATE INDEX qc_reviews_task_idx ON qc_reviews (task_id, created_at DESC);

-- ───────────────────────── Agent Manager ─────────────────────────

-- Hợp đồng thực thi mỗi lượt chạy trợ lý (đặc tả mục 7)
CREATE TABLE agent_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  agent_role           text NOT NULL CHECK (agent_role IN ('booking','cleaning','guest','manager')),
  task_key             text NOT NULL,
  entity_type          text,
  entity_id            uuid,
  entity_version       int,
  tools_allowed        text[] NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','timed_out','cancelled','skipped_paused')),
  attempt              int NOT NULL DEFAULT 0,
  max_attempts         int NOT NULL DEFAULT 3,
  timeout_ms           int NOT NULL DEFAULT 60000,
  budget_minor         int NOT NULL DEFAULT 0,
  cost_minor           int NOT NULL DEFAULT 0,
  input                jsonb NOT NULL DEFAULT '{}'::jsonb,
  output               jsonb,
  error                text,
  heartbeat_at         timestamptz,
  started_at           timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, agent_role, task_key)
);
CREATE INDEX agent_runs_status_idx ON agent_runs (org_id, status, created_at DESC);

CREATE TABLE manager_reports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  kind                 text NOT NULL CHECK (kind IN ('morning','evening','adhoc')),
  ops_date             date NOT NULL,
  cutoff_at            timestamptz NOT NULL,
  data                 jsonb NOT NULL,
  narrative            text,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','superseded')),
  generated_by         uuid REFERENCES users(id),
  approved_by          uuid REFERENCES users(id),
  approved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX manager_reports_date_idx ON manager_reports (org_id, ops_date DESC, kind);

-- Cấu hình người nhận báo cáo/cảnh báo (giờ gửi theo giờ Budapest). enabled=false tới khi Ngọc/Dịu chốt.
CREATE TABLE report_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('morning','evening','p1_alert')),
  channel       text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','inapp')),
  send_time     time,
  enabled       boolean NOT NULL DEFAULT false,
  UNIQUE (org_id, user_id, kind, channel)
);

-- ───────────────────────── Thông báo cho đội ─────────────────────────

-- Mẫu tin: chỉ mẫu đã duyệt mới được dùng để gửi.
CREATE TABLE message_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  key           text NOT NULL,
  language      text NOT NULL DEFAULT 'vi',
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key, language)
);

CREATE TABLE staff_notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  recipient_user_id    uuid NOT NULL REFERENCES users(id),
  channel              text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','inapp')),
  template_key         text NOT NULL,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  rendered_body        text,
  dedupe_key           text NOT NULL,
  -- suppressed: công tắc tắt / vượt hạn mức / chưa có mẫu duyệt — ghi lại chứ không âm thầm bỏ
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','suppressed')),
  suppressed_reason    text,
  attempts             int NOT NULL DEFAULT 0,
  external_message_id  text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  UNIQUE (org_id, dedupe_key)
);
CREATE INDEX staff_notifications_queue_idx ON staff_notifications (status, created_at);

-- Mã bí mật webhook theo connector (lưu băm) — tách khỏi config JSON hiển thị trên giao diện
ALTER TABLE connector_accounts ADD COLUMN webhook_secret_hash text;
