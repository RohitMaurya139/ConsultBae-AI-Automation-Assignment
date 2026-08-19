/**
 * Structural cleaning, asserted against the real files.
 * Row numbers here are real line numbers - open the CSV and check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSource, SOURCES } from '../pipeline/clean.js';

const byName = (n) => SOURCES.find((s) => s.name.startsWith(n));
const load = (n) => { const s = byName(n); return loadSource(s.path, s); };

const typesOf = (issues) => issues.map((i) => i.issue_type);

test('source1: 42 rows, no structural defects', () => {
  const { rows, issues } = load('source1');
  assert.equal(rows.length, 42);
  assert.equal(issues.length, 0);
});

test('source2: blank row is dropped, not ingested as an empty person', () => {
  const { issues } = load('source2');
  const blank = issues.find((i) => i.issue_type === 'blank_row');
  assert.ok(blank, 'blank row not detected');
  assert.equal(blank.source_row, 12);
});

test('source2: rotated row is detected structurally and repaired', () => {
  const { issues } = load('source2');
  const shift = issues.find((i) => i.issue_type === 'column_shift');
  assert.ok(shift, 'column shift not detected');
  assert.equal(shift.source_row, 20);
  // Repaired into header order: email first, skills last.
  assert.match(shift.action_taken, /^Rotated fields back into header order -> ISHA\.CHOPRA95@/);
  assert.match(shift.action_taken, /react, javascript, mysql$/);
});

test('source2: repairing the rotated row is what reveals it is a duplicate', () => {
  const { rows, issues } = load('source2');
  const dup = issues.find((i) => i.issue_type === 'duplicate_row_in_source');
  assert.ok(dup, 'duplicate not detected');
  assert.equal(dup.source_row, 20);
  assert.match(dup.action_taken, /duplicate of row 7/);
  // 32 data rows - 1 blank - 1 duplicate = 30
  assert.equal(rows.length, 30);
  // and only one Isha Chopra survives
  const ishas = rows.filter((r) => /isha\.chopra95/i.test(r.data.email_id ?? ''));
  assert.equal(ishas.length, 1);
});

test('source3: header repeated mid-file is dropped, not read as a person named "Name"', () => {
  const { rows, issues } = load('source3');
  const rep = issues.find((i) => i.issue_type === 'repeated_header');
  assert.ok(rep, 'repeated header not detected');
  assert.equal(rep.source_row, 16);
  assert.equal(rows.length, 30);
  assert.ok(!rows.some((r) => r.data.Name === 'Name'), 'header row leaked into the data');
});

test('every kept row carries its original line number for traceability', () => {
  for (const s of SOURCES) {
    const { rows } = loadSource(s.path, s);
    for (const r of rows) {
      assert.ok(Number.isInteger(r.sourceRow) && r.sourceRow > 1, `bad sourceRow in ${s.name}`);
      assert.equal(r.sourceFile, s.name);
    }
  }
});

test('all three files together yield 102 clean rows', () => {
  const total = SOURCES.reduce((n, s) => n + loadSource(s.path, s).rows.length, 0);
  assert.equal(total, 102);   // 42 + 30 + 30
});

test('trailing whitespace is preserved for the normalisers to find', () => {
  // 'Noida ' and 'gurugram ' must survive cleaning so they get logged as city_whitespace.
  const { rows } = load('source1');
  assert.ok(rows.some((r) => r.data.City !== r.data.City.trim()),
    'cleaning stripped whitespace that should have been reported');
});
