/**
 * Task 1 entry point:  npm run pipeline
 *
 *   3 CSVs -> structural clean -> normalise -> match -> golden records -> SQLite
 *
 * Idempotent: drops and rebuilds the people tables on every run, so re-running
 * never doubles anything. Audio submissions are preserved - they are real user
 * data, not derived from the CSVs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import 'dotenv/config';

import { loadSource, SOURCES } from './clean.js';
import { stageAll } from './stage.js';
import { matchRecords } from './match.js';
import { buildGoldenRecord } from './survivorship.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? 'consultbae.db';

const rel = (p) => resolve(ROOT, p);

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function runPipeline({ dbPath = DB_PATH, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const allIssues = [];

  // -- 1. load + structural clean -------------------------------------------
  const cleanRows = [];
  for (const spec of SOURCES) {
    const { rows, issues } = loadSource(rel(spec.path), spec);
    cleanRows.push(...rows);
    allIssues.push(...issues.map((i) => ({ ...i, source_file: spec.name })));
    log(`  ${spec.name.padEnd(34)} ${String(rows.length).padStart(3)} rows kept, ${issues.length} structural issue(s)`);
  }

  // -- 2. normalise ----------------------------------------------------------
  const { records, issues: stageIssues } = stageAll(cleanRows);
  allIssues.push(...stageIssues);

  // -- 3. match --------------------------------------------------------------
  const { clusters, issues: matchIssues, reviewQueue } = matchRecords(records);
  allIssues.push(...matchIssues);

  // -- 4. golden records -----------------------------------------------------
  const people = clusters.map((c) => {
    const built = buildGoldenRecord(c.indices.map((i) => records[i]), c);
    allIssues.push(...built.issues);
    return built;
  });

  // -- 5. persist ------------------------------------------------------------
  const db = new Database(rel(dbPath));
  db.pragma('journal_mode = WAL');
  db.exec(readFileSync(rel('db/schema.sql'), 'utf8'));

  // Rebuild the CSV-derived tables only. audio_submissions is user data.
  db.exec(`
    DELETE FROM person_skills;
    DELETE FROM person_sources;
    DELETE FROM person_identifiers;
    DELETE FROM skills;
    DELETE FROM data_issues;
    UPDATE audio_submissions SET person_id = NULL;
    DELETE FROM people;
  `);

  const insPerson = db.prepare(`
    INSERT INTO people (full_name, primary_email, primary_phone, city, experience_years,
      current_ctc_inr, rate_inr_per_hour, rate_raw, gig_status, is_verified,
      projects_completed, applied_date, skill_category, match_confidence, match_reason)
    VALUES (@full_name, @primary_email, @primary_phone, @city, @experience_years,
      @current_ctc_inr, @rate_inr_per_hour, @rate_raw, @gig_status, @is_verified,
      @projects_completed, @applied_date, @skill_category, @match_confidence, @match_reason)
  `);
  const insIdent  = db.prepare(`INSERT INTO person_identifiers (person_id, id_type, value, source_file, is_primary) VALUES (?,?,?,?,?)`);
  const insSource = db.prepare(`INSERT INTO person_sources (person_id, source_file, source_row, raw_json) VALUES (?,?,?,?)`);
  const insSkill  = db.prepare(`INSERT OR IGNORE INTO skills (canonical_name, match_key) VALUES (?,?)`);
  const getSkill  = db.prepare(`SELECT skill_id FROM skills WHERE match_key = ?`);
  const linkSkill = db.prepare(`INSERT OR IGNORE INTO person_skills (person_id, skill_id) VALUES (?,?)`);
  const insIssue  = db.prepare(`
    INSERT INTO data_issues (source_file, source_row, column_name, issue_type, severity, raw_value, action_taken, detail)
    VALUES (@source_file, @source_row, @column_name, @issue_type, @severity, @raw_value, @action_taken, @detail)
  `);

  const writeAll = db.transaction(() => {
    for (const p of people) {
      const { lastInsertRowid: personId } = insPerson.run(p.person);
      for (const id of p.identifiers) insIdent.run(personId, id.id_type, id.value, id.source_file, id.is_primary);
      for (const s of p.sources) insSource.run(personId, s.source_file, s.source_row, s.raw_json);
      for (const s of p.skills) {
        insSkill.run(s.canonical_name, s.match_key);
        linkSkill.run(personId, getSkill.get(s.match_key).skill_id);
      }
    }
    for (const i of allIssues) {
      insIssue.run({
        source_file: i.source_file ?? 'unknown',
        source_row: i.source_row ?? null,
        column_name: i.column_name ?? null,
        issue_type: i.issue_type,
        severity: i.severity,
        raw_value: i.raw_value ?? null,
        action_taken: i.action_taken,
        detail: i.detail ?? null,
      });
    }
  });
  writeAll();

  // -- 6. reports ------------------------------------------------------------
  if (!existsSync(rel('reports'))) mkdirSync(rel('reports'), { recursive: true });

  const cols = ['source_file', 'source_row', 'column_name', 'issue_type', 'severity', 'raw_value', 'action_taken', 'detail'];
  const rows = db.prepare(`SELECT ${cols.join(',')} FROM data_issues ORDER BY severity DESC, issue_type, source_file, source_row`).all();
  writeFileSync(rel('reports/data_issues.csv'),
    [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n') + '\n');

  writeFileSync(rel('reports/review_queue.json'), JSON.stringify(reviewQueue, null, 2) + '\n');

  // -- 7. summary ------------------------------------------------------------
  const count = (sql) => db.prepare(sql).get().n;
  const summary = {
    sourceRows: cleanRows.length,
    people: count('SELECT COUNT(*) n FROM people'),
    byConfidence: db.prepare('SELECT match_confidence c, COUNT(*) n FROM people GROUP BY c ORDER BY n DESC').all(),
    identifiers: count('SELECT COUNT(*) n FROM person_identifiers'),
    skills: count('SELECT COUNT(*) n FROM skills'),
    issues: count('SELECT COUNT(*) n FROM data_issues'),
    issuesByType: db.prepare('SELECT issue_type t, severity s, COUNT(*) n FROM data_issues GROUP BY t, s ORDER BY n DESC').all(),
    reviewQueue: reviewQueue.length,
  };

  if (!quiet) {
    log('');
    log(`  ${cleanRows.length} source rows  ->  ${summary.people} people  (${cleanRows.length - summary.people} duplicates collapsed)`);
    log('');
    for (const r of summary.byConfidence) log(`    ${String(r.n).padStart(3)}  ${r.c}`);
    log('');
    log(`  ${summary.identifiers} identifiers, ${summary.skills} distinct skills`);
    log(`  ${summary.issues} data issues logged across ${summary.issuesByType.length} types  -> reports/data_issues.csv`);
    log(`  ${summary.reviewQueue} item(s) queued for human review        -> reports/review_queue.json`);
  }

  db.close();
  return summary;
}

// Only run when invoked directly, so tests can import runPipeline().
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log('\nConsultBae merge pipeline\n');
  runPipeline();
  console.log('\nDone.\n');
}
