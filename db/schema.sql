-- ConsultBae assignment - merged people database
-- One row in `people` = one real human, however many source rows fed into them.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- The golden record. Every field here is the survivorship winner across
-- however many source rows were matched together (see pipeline/survivorship.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people (
  person_id           INTEGER PRIMARY KEY,
  full_name           TEXT    NOT NULL,
  primary_email       TEXT,                 -- NULL: source3-only people have no email
  primary_phone       TEXT,                 -- E.164 (+91XXXXXXXXXX). NULL: source2-only people have no phone
  city                TEXT,
  experience_years    REAL,                 -- source1 only
  current_ctc_inr     INTEGER,              -- source1 only, normalised to absolute INR/year
  rate_inr_per_hour   REAL,                 -- source2 only, normalised from /hr and k/month
  rate_raw            TEXT,                 -- keep the original string; the conversion is an assumption
  gig_status          TEXT CHECK (gig_status IN ('active','inactive','paused','unknown')),
  is_verified         INTEGER CHECK (is_verified IN (0,1)),
  projects_completed  INTEGER,
  applied_date        TEXT,                 -- ISO-8601 date
  skill_category      TEXT,                 -- written back by the n8n LLM flow (Task 2)
  match_confidence    TEXT CHECK (match_confidence IN ('high','medium','single-source')),
  match_reason        TEXT,                 -- why these rows became one person - auditable
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email ON people(primary_email) WHERE primary_email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_phone ON people(primary_phone) WHERE primary_phone IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Every identifier ever seen for a person, not just the winning one.
-- This is what lets `alt.nikhil.chopra70@example.com` keep pointing at the
-- same human as `nikhil.chopra70@example.com`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_identifiers (
  identifier_id  INTEGER PRIMARY KEY,
  person_id      INTEGER NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  id_type        TEXT    NOT NULL CHECK (id_type IN ('email','phone')),
  value          TEXT    NOT NULL,          -- already normalised
  source_file    TEXT    NOT NULL,
  is_primary     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id_type, value)
);
CREATE INDEX IF NOT EXISTS idx_ident_person ON person_identifiers(person_id);

-- ---------------------------------------------------------------------------
-- Full lineage: which source rows produced this person, with the raw payload.
-- Lets you answer "where did this value come from?" without re-reading CSVs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_sources (
  person_source_id INTEGER PRIMARY KEY,
  person_id        INTEGER NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  source_file      TEXT    NOT NULL,
  source_row       INTEGER NOT NULL,        -- 1-based line number in the original CSV
  raw_json         TEXT    NOT NULL,
  UNIQUE (source_file, source_row)
);
CREATE INDEX IF NOT EXISTS idx_psrc_person ON person_sources(person_id);

-- ---------------------------------------------------------------------------
-- Skills, deduplicated across sources (source1 is Title Case, source2 lowercase).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skills (
  skill_id       INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,      -- display form, e.g. "REST APIs"
  match_key      TEXT NOT NULL UNIQUE       -- lookup form, e.g. "rest apis"
);

CREATE TABLE IF NOT EXISTS person_skills (
  person_id INTEGER NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  skill_id  INTEGER NOT NULL REFERENCES skills(skill_id)  ON DELETE CASCADE,
  PRIMARY KEY (person_id, skill_id)
);

-- ---------------------------------------------------------------------------
-- Task 3. person_id is nullable: someone can submit audio without being in
-- any of the 3 source files, in which case the pipeline creates them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audio_submissions (
  submission_id   INTEGER PRIMARY KEY,
  person_id       INTEGER REFERENCES people(person_id) ON DELETE SET NULL,
  submitted_name  TEXT    NOT NULL,
  submitted_phone TEXT    NOT NULL,
  file_path       TEXT    NOT NULL,
  original_name   TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  -- required by the brief
  duration_sec    REAL,
  sample_rate_hz  INTEGER,
  bitrate_kbps    REAL,
  loudness_dbfs   REAL,
  -- bonus
  channels        INTEGER,
  codec           TEXT,
  peak_dbfs       REAL,
  loudness_lufs   REAL,
  noise_floor_dbfs REAL,
  snr_db          REAL,
  clipping_pct    REAL,
  quality_label   TEXT,
  analysis_error  TEXT,                     -- non-fatal: store the row even if analysis fails
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audio_person ON audio_submissions(person_id);

-- ---------------------------------------------------------------------------
-- Task 4 is generated from this table, not hand-written. Every clean-up the
-- pipeline performs logs a row here, so the report can never drift from the code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_issues (
  issue_id     INTEGER PRIMARY KEY,
  source_file  TEXT NOT NULL,
  source_row   INTEGER,
  column_name  TEXT,
  issue_type   TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  raw_value    TEXT,
  action_taken TEXT NOT NULL,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_type ON data_issues(issue_type);
