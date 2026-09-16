-- VD Hotel — bổ sung Đợt 2
-- 1) Tin gửi ra ngoài: trạng thái 'sending' + thời điểm giành quyền gửi, để chỉ một tiến trình gửi và phát hiện tin kẹt.
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('received','draft','pending_approval','queued','sending','sent','delivered','read','failed','discarded'));
ALTER TABLE messages ADD COLUMN locked_at timestamptz;
ALTER TABLE messages ADD COLUMN connector_id uuid REFERENCES connector_accounts(id);
CREATE INDEX messages_outbound_queue_idx ON messages (status, created_at) WHERE direction = 'out' AND status IN ('queued','sending');

ALTER TABLE staff_notifications ADD COLUMN locked_at timestamptz;

-- 2) Tài liệu/ảnh hướng dẫn gắn với mục Q&A (đặc tả: "tài liệu/ảnh hướng dẫn"). File nằm ngoài public, đọc qua API có quyền.
CREATE TABLE qa_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  qa_entry_id   uuid NOT NULL REFERENCES qa_entries(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('image','document','link')),
  title         text NOT NULL,
  storage_key   text,
  url           text,
  mime_type     text,
  bytes         int,
  sha256        text,
  uploaded_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'link' AND url IS NOT NULL) OR (kind <> 'link' AND storage_key IS NOT NULL))
);
CREATE INDEX qa_attachments_entry_idx ON qa_attachments (qa_entry_id);
