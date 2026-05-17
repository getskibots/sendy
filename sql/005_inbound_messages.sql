-- Migration 005: inbound_messages — full thread history
--
-- Prior to this migration, threads.body_text was overwritten on every new inbound,
-- losing the conversation history. This table preserves every inbound email as a
-- separate row so the dashboard can show a proper timeline.
--
-- threads.body_text is kept as a denormalized cache of the LATEST inbound only,
-- for fast inbox-list previews without an extra join.
--
-- raw_s3_key has a partial unique index (WHERE NOT NULL) for idempotency:
-- if Lambda processes the same S3 object twice, the second insert is rejected
-- with code 23505 and the Lambda swallows it gracefully.

CREATE TABLE IF NOT EXISTS inbound_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  from_email    TEXT NOT NULL,
  from_name     TEXT,
  subject       TEXT,
  body_text     TEXT,
  body_text_raw TEXT,
  body_html     TEXT,
  message_id    TEXT,
  in_reply_to   TEXT,
  ref_header    TEXT,
  raw_s3_key    TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup for timeline queries.
CREATE INDEX IF NOT EXISTS inbound_messages_thread_received_idx
  ON inbound_messages (thread_id, received_at);

-- Idempotency: one row per S3 object.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_s3_key_uniq
  ON inbound_messages (raw_s3_key)
  WHERE raw_s3_key IS NOT NULL;

-- Add inbound_messages to the realtime publication so the dashboard
-- receives live updates when new emails arrive.
-- Safe to re-run: ADD TABLE is idempotent in Supabase realtime.
ALTER PUBLICATION supabase_realtime ADD TABLE inbound_messages;
