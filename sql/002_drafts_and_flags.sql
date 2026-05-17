-- Migration 002: drafts and escalation_flags

-- drafts: one row per AI-generated reply candidate for a thread.
-- Multiple drafts per thread are normal (regenerate creates a new row).
-- source values: 'ai' (initial), 'regenerate' (staff-requested redo).
-- parent_draft_id: nullable self-reference, reserved for future draft lineage.

CREATE TABLE IF NOT EXISTS drafts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id        UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_draft_id  UUID,
  model            TEXT NOT NULL,
  prompt_version   TEXT NOT NULL DEFAULT 'v1',
  category         TEXT NOT NULL,
  confidence       NUMERIC NOT NULL DEFAULT 0,
  needs_human      BOOLEAN NOT NULL DEFAULT true,
  suggested_subject TEXT,
  suggested_reply   TEXT,
  internal_notes    TEXT,
  raw_response      TEXT,
  source            TEXT NOT NULL DEFAULT 'ai',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Covers the common query: latest draft for a thread.
CREATE INDEX IF NOT EXISTS idx_drafts_thread ON drafts (thread_id, created_at DESC);

-- escalation_flags: raised when a thread is blocked (sensitive category) or
-- needs_human=true. Multiple flags per thread are allowed.
-- raised_by values: 'ai', 'staff', 'system'.
-- resolved: staff can clear a flag after handling.

CREATE TABLE IF NOT EXISTS escalation_flags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  detail     TEXT,
  raised_by  TEXT NOT NULL DEFAULT 'ai',
  resolved   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flags_thread ON escalation_flags (thread_id);
