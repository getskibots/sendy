-- Migration 006: fix threading headers + soft delete + idempotency index
--
-- FIXES TWO PRODUCTION BUGS and one missing index:
--
-- 1. threads.message_id (Bug #3 — Gmail threading broken)
--    The Lambda stores the guest's latest Message-Id here so that outbound
--    SES emails can set In-Reply-To correctly. Without this column, every
--    reply goes out with no threading headers and lands as a new standalone
--    thread in Gmail/Outlook.
--
-- 2. threads.deleted_at (Migration 004 was never applied to production)
--    Soft delete support for the dashboard trash filter.
--
-- 3. send_logs index on (draft_id, status)
--    Required for the idempotency lookup in sendViaSES to stay fast as
--    send_logs grows. Currently a full table scan; this makes it O(log n).

-- (1) Add message_id to threads
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS message_id TEXT;

-- (2) Add deleted_at to threads (004 was not applied)
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- (3) Idempotency index on send_logs
CREATE INDEX IF NOT EXISTS idx_send_logs_draft_status
  ON send_logs (draft_id, status);
