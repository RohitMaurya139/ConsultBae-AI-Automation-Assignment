/**
 * Database access for the web app.
 *
 * Deliberately the SAME consultbae.db the Task 1 pipeline builds - an audio
 * submission is linked to the merged person record, not stored in a side table
 * that has to be reconciled later.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import 'dotenv/config';

import { normalizePhone, normalizeName } from '../pipeline/normalize.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = resolve(ROOT, process.env.DB_PATH ?? 'consultbae.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Safe to run against an existing database - every statement is IF NOT EXISTS.
// This means `npm start` works even if someone forgot to run the pipeline first.
db.exec(readFileSync(resolve(ROOT, 'db/schema.sql'), 'utf8'));

/**
 * Link a submission to an existing person by phone, reusing the pipeline's own
 * normaliser so '+91 90000 00254', '09000000254' and '9000000254' all find the
 * same human. If nobody matches, create a person so the submission is never
 * orphaned - that person is marked as coming from the app rather than a CSV.
 */
export function findOrCreatePerson({ name, phone }) {
  const normalised = normalizePhone(phone).value;
  const displayName = normalizeName(name).value ?? String(name ?? '').trim();

  if (normalised) {
    const hit = db.prepare(`
      SELECT p.person_id FROM person_identifiers i
      JOIN people p USING (person_id)
      WHERE i.id_type = 'phone' AND i.value = ?
    `).get(normalised);
    if (hit) return { personId: hit.person_id, created: false, normalisedPhone: normalised };
  }

  const info = db.prepare(`
    INSERT INTO people (full_name, primary_phone, match_confidence, match_reason)
    VALUES (?, ?, 'single-source', 'created by the audio collection app')
  `).run(displayName, normalised);

  const personId = info.lastInsertRowid;
  if (normalised) {
    db.prepare(`
      INSERT OR IGNORE INTO person_identifiers (person_id, id_type, value, source_file, is_primary)
      VALUES (?, 'phone', ?, 'audio_app', 1)
    `).run(personId, normalised);
  }
  return { personId, created: true, normalisedPhone: normalised };
}

export function insertSubmission(row) {
  return db.prepare(`
    INSERT INTO audio_submissions (
      person_id, submitted_name, submitted_phone, file_path, original_name, mime_type,
      size_bytes, duration_sec, sample_rate_hz, bitrate_kbps, loudness_dbfs, channels,
      codec, peak_dbfs, loudness_lufs, noise_floor_dbfs, snr_db, clipping_pct,
      quality_label, analysis_error
    ) VALUES (
      @person_id, @submitted_name, @submitted_phone, @file_path, @original_name, @mime_type,
      @size_bytes, @duration_sec, @sample_rate_hz, @bitrate_kbps, @loudness_dbfs, @channels,
      @codec, @peak_dbfs, @loudness_lufs, @noise_floor_dbfs, @snr_db, @clipping_pct,
      @quality_label, @analysis_error
    )
  `).run(row).lastInsertRowid;
}

export function listSubmissions() {
  return db.prepare(`
    SELECT s.*, p.full_name AS matched_name, p.city, p.match_confidence
    FROM audio_submissions s
    LEFT JOIN people p USING (person_id)
    ORDER BY s.submission_id DESC
  `).all();
}

export function getSubmission(id) {
  return db.prepare('SELECT * FROM audio_submissions WHERE submission_id = ?').get(id);
}

/** Task 2 support: people the LLM flow has not categorised yet. */
export function listUntaggedPeople(limit = 100) {
  return db.prepare(`
    SELECT p.person_id, p.full_name, p.city,
           COALESCE(GROUP_CONCAT(s.canonical_name, ', '), '') AS skills
    FROM people p
    LEFT JOIN person_skills ps USING (person_id)
    LEFT JOIN skills s USING (skill_id)
    WHERE p.skill_category IS NULL
    GROUP BY p.person_id
    HAVING skills <> ''
    LIMIT ?
  `).all(limit);
}

export function setSkillCategory(personId, category) {
  return db.prepare(`
    UPDATE people SET skill_category = ?, updated_at = datetime('now') WHERE person_id = ?
  `).run(category, personId).changes;
}

export function stats() {
  const one = (sql) => db.prepare(sql).get();
  return {
    people: one('SELECT COUNT(*) n FROM people').n,
    submissions: one('SELECT COUNT(*) n FROM audio_submissions').n,
    tagged: one('SELECT COUNT(*) n FROM people WHERE skill_category IS NOT NULL').n,
    issues: one('SELECT COUNT(*) n FROM data_issues').n,
  };
}
