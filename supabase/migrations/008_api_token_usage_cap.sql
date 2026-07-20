-- Migration 008: Daily usage cap per API token
--
-- Adds two columns to api_tokens:
--   usage_count    — calls made in the current window
--   usage_reset_at — when the current window expires (set to now() + 1 day on first call)
--
-- The application layer reads, resets if expired, increments, and enforces the cap
-- on every authenticated request. No DB trigger needed — app logic owns the check.
--
-- HOW TO RUN:
--   Paste into Supabase Dashboard → SQL Editor → Run.

ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS usage_count    integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_reset_at timestamptz;
