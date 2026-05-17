-- Migration 004: soft delete on threads
--
-- Adds deleted_at to threads so the dashboard can hide dismissed threads
-- without losing history. NULL = visible, non-NULL = soft-deleted.
--
-- STATUS: NOT applied to production as of 2026-05-17.
-- Run migration 006 instead — it applies this with IF NOT EXISTS so it's
-- safe regardless of whether 004 was previously run.

ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
