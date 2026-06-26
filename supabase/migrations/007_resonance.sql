-- Migration 007: Replace reflect score dials with a single resonance verdict
--
-- Move B (2026-06-26): the Reflect tab's relevance × intensity dials are replaced
-- by one resonance verdict per signal — dissonant / equivocal / resonant. The
-- verdict is a human judgment (anchored to the protected-term grammar), never
-- assigned by the extractor. Code now reads and writes `resonance` on every
-- evaluative_signals upsert, so this column must exist or all ontology saves fail.
--
-- HOW TO RUN:
--   Paste into Supabase Dashboard → SQL Editor → Run.
--
-- Nullable so existing rows are unaffected (NULL = "not yet judged").
-- The old relevance_score / intensity_score columns from migration 003 are left
-- in place (now unwritten); drop them once the new flow is confirmed in prod.

ALTER TABLE evaluative_signals
  ADD COLUMN IF NOT EXISTS resonance text
  CHECK (resonance IN ('dissonant', 'equivocal', 'resonant'));
