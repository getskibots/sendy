-- Migration 001: core tables — threads and system_settings
--
-- threads: one row per guest conversation. Denormalized cache of the latest
-- inbound for fast inbox-list rendering. Full history lives in inbound_messages (005).
--
-- system_settings: per-resort feature flags. Required key: auto_send_enabled.

CREATE TABLE IF NOT EXISTS threads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resort_id     INTEGER NOT NULL DEFAULT 1,
  resort_name   TEXT NOT NULL DEFAULT 'Jackson Hole Mountain Resort',
  subject       TEXT NOT NULL,
  subject_normalized TEXT NOT NULL,
  guest_email   TEXT NOT NULL,
  guest_name    TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  last_inbound_at  TIMESTAMPTZ DEFAULT now(),
  last_outbound_at TIMESTAMPTZ,
  raw_s3_key    TEXT,
  in_reply_to   TEXT,
  ref_header    TEXT,
  body_text     TEXT,
  body_text_raw TEXT,
  body_html     TEXT,
  headers_json  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_threads_resort_status ON threads (resort_id, status);
CREATE INDEX IF NOT EXISTS idx_threads_status        ON threads (status);
CREATE INDEX IF NOT EXISTS idx_threads_guest         ON threads (guest_email);
CREATE INDEX IF NOT EXISTS idx_threads_updated       ON threads (updated_at DESC);

-- system_settings: (resort_id, key) is unique so each resort has its own flag set.
CREATE TABLE IF NOT EXISTS system_settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resort_id  INTEGER NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resort_id, key)
);

-- Seed the auto_send_enabled flag for Jackson Hole (resort_id = 1).
-- ON CONFLICT DO NOTHING is safe to re-run.
INSERT INTO system_settings (resort_id, key, value)
VALUES (1, 'auto_send_enabled', 'false')
ON CONFLICT (resort_id, key) DO NOTHING;
