-- Migration 003: send_logs
--
-- One row per send attempt (success or failure).
-- status values: 'sent_via_ses', 'sent_via_microsoft', 'marked_sent', 'failed', 'deduplicated'.
-- sent_by values: 'auto:lambda', 'manual:dashboard', 'manual:dashboard:followup'.
-- error_detail: populated on status='failed', first 1000 chars of the error.

CREATE TABLE IF NOT EXISTS send_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id      UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  draft_id       UUID,
  subject        TEXT,
  body_text      TEXT,
  status         TEXT NOT NULL CHECK (status = ANY (ARRAY['sent_via_ses','sent_via_microsoft','marked_sent','failed','deduplicated'])),
  sent_by        TEXT,
  ses_message_id TEXT,
  error_detail   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_send_logs_thread ON send_logs (thread_id);
