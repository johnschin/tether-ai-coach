-- ══════════════════════════════════════════════════════════════════════
-- Tether HR Migration v2
-- Adds: emotional_themes table, change_context column on companies,
--       company_id on sessions and adkar_assessments (if not present)
-- Run in: Supabase → SQL Editor
-- ══════════════════════════════════════════════════════════════════════

-- ── 1. Add change_context to companies ──────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS change_context TEXT DEFAULT 'General';

-- ── 2. Add company_id to sessions (if missing) ──────────────────────────
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- ── 3. Add company_id to adkar_assessments (if missing) ─────────────────
ALTER TABLE adkar_assessments
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- ── 4. Create emotional_themes table ────────────────────────────────────
-- Stores the nightly AI-generated theme analysis per company.
-- The themes JSONB column holds the aggregated output from the Worker.
-- Structure of themes JSON:
-- {
--   "anxiety":      { "percentage": 34, "phrases": ["phrase one", ...] },
--   "resistance":   { "percentage": 28, "phrases": ["phrase one", ...] },
--   "hopeful":      { "percentage": 18, "phrases": ["phrase one", ...] },
--   "exhausted":    { "percentage": 14, "phrases": ["phrase one", ...] },
--   "disconnected": { "percentage": 6,  "phrases": ["phrase one", ...] }
-- }

CREATE TABLE IF NOT EXISTS emotional_themes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  analyzed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  employee_count  INTEGER NOT NULL DEFAULT 0,
  session_count   INTEGER NOT NULL DEFAULT 0,
  themes          JSONB NOT NULL DEFAULT '{}',
  date_range_from TIMESTAMPTZ,
  date_range_to   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast HR dashboard queries
CREATE INDEX IF NOT EXISTS idx_emotional_themes_company_analyzed
  ON emotional_themes(company_id, analyzed_at DESC);

-- ── 5. Row Level Security ────────────────────────────────────────────────
ALTER TABLE emotional_themes ENABLE ROW LEVEL SECURITY;

-- HR admins can read their company's theme data only
CREATE POLICY "HR admins read own company themes"
  ON emotional_themes FOR SELECT
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles
      WHERE id = auth.uid() AND is_admin = TRUE
    )
  );

-- Service role (used by Cloudflare Worker) can insert
CREATE POLICY "Service role can insert themes"
  ON emotional_themes FOR INSERT
  WITH CHECK (TRUE);

-- ── 6. Backfill company_id on sessions from user_profiles ────────────────
UPDATE sessions s
SET company_id = up.company_id
FROM user_profiles up
WHERE s.user_id = up.id
  AND s.company_id IS NULL
  AND up.company_id IS NOT NULL;

UPDATE adkar_assessments a
SET company_id = up.company_id
FROM user_profiles up
WHERE a.user_id = up.id
  AND a.company_id IS NULL
  AND up.company_id IS NOT NULL;

-- ── 7. Verify ────────────────────────────────────────────────────────────
SELECT 
  'emotional_themes' AS table_name,
  COUNT(*) AS row_count
FROM emotional_themes
UNION ALL
SELECT 'companies', COUNT(*) FROM companies
UNION ALL
SELECT 'sessions with company_id', COUNT(*) FROM sessions WHERE company_id IS NOT NULL;
