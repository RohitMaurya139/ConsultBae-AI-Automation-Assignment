/**
 * Web app integration tests.
 *
 * Runs against a throwaway database and upload directory so the real
 * consultbae.db is never touched. Both env vars must be set before importing
 * the app, because db.js resolves them at import time.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cb-app-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = join(TMP, 'test.db');
process.env.UPLOAD_DIR = join(TMP, 'uploads');

const { default: app } = await import('../app/server.js');
const { db } = await import('../app/db.js');

let base;
let server;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db?.close();
  rmSync(TMP, { recursive: true, force: true });
});

/** Post a fixture through the real multipart form path. */
async function submit({ name, phone, file, type = 'audio/wav', filename }) {
  const form = new FormData();
  form.set('name', name);
  form.set('phone', phone);
  if (file) {
    const buf = readFileSync(resolve('tests/fixtures', file));
    form.set('audio', new Blob([buf], { type }), filename ?? file);
  }
  const res = await fetch(`${base}/submit`, { method: 'POST', body: form });
  return { status: res.status, html: await res.text() };
}

test('the submit page renders', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Submit a recording/);
  assert.match(html, /Record in the browser/);
});

test('the submissions page renders when empty', async () => {
  const res = await fetch(`${base}/submissions`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Nothing submitted yet|All submissions/);
});

test('name, phone and a file are all required', async () => {
  assert.match((await submit({ name: '', phone: '9000000001', file: 'tone_44k.wav' })).html, /Name is required/);
  assert.match((await submit({ name: 'A', phone: '', file: 'tone_44k.wav' })).html, /Phone number is required/);
  assert.match((await submit({ name: 'A', phone: '9000000001' })).html, /Record something or choose an audio file/);
});

test('a submission is stored with every required property extracted', async () => {
  const { status, html } = await submit({
    name: 'Speech Tester', phone: '9000000501', file: 'speech_quiet_room.wav',
  });
  assert.equal(status, 200);
  assert.match(html, /Saved/);

  const row = db.prepare('SELECT * FROM audio_submissions ORDER BY submission_id DESC LIMIT 1').get();
  // The four the brief explicitly requires.
  assert.ok(row.duration_sec > 3.5, `duration ${row.duration_sec}`);
  assert.equal(row.sample_rate_hz, 16000);
  assert.ok(row.bitrate_kbps > 0);
  assert.ok(row.loudness_dbfs < 0);
  // The bonus quality estimate.
  assert.ok(row.snr_db > 25, `snr ${row.snr_db}`);
  assert.equal(row.quality_label, 'good');
  assert.equal(row.analysis_error, null);
});

test('a WebM recording from the browser is handled, not just WAV uploads', async () => {
  await submit({ name: 'Webm Tester', phone: '9000000502', file: 'browser_like.webm', type: 'audio/webm' });
  const row = db.prepare('SELECT * FROM audio_submissions ORDER BY submission_id DESC LIMIT 1').get();
  assert.equal(row.codec, 'opus');
  assert.equal(row.sample_rate_hz, 48000);
  assert.ok(row.bitrate_kbps > 0, 'no bitrate for WebM');
});

test('an unknown phone number creates a person rather than orphaning the row', async () => {
  await submit({ name: 'Brand New', phone: '9000000503', file: 'tone_44k.wav' });
  const row = db.prepare('SELECT * FROM audio_submissions ORDER BY submission_id DESC LIMIT 1').get();
  assert.ok(row.person_id, 'submission has no person_id');
  const person = db.prepare('SELECT * FROM people WHERE person_id = ?').get(row.person_id);
  assert.equal(person.full_name, 'Brand New');
  assert.match(person.match_reason, /audio collection app/);
});

test('a messy phone format links to the person created by an earlier submission', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM people').get().n;
  // Same human as 9000000503 above, written completely differently.
  await submit({ name: 'Brand New Again', phone: '+91 90000 00503', file: 'tone_44k.wav' });
  const after = db.prepare('SELECT COUNT(*) n FROM people').get().n;
  assert.equal(after, before, 'a duplicate person was created for the same phone number');
});

test('non-audio uploads are rejected', async () => {
  const form = new FormData();
  form.set('name', 'X'); form.set('phone', '9000000504');
  form.set('audio', new Blob([Buffer.from('{}')], { type: 'application/json' }), 'x.json');
  const res = await fetch(`${base}/submit`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Unsupported audio type/);
});

test('stored audio streams back', async () => {
  const row = db.prepare('SELECT * FROM audio_submissions ORDER BY submission_id LIMIT 1').get();
  const res = await fetch(`${base}/audio/${row.submission_id}`);
  assert.equal(res.status, 200);
  assert.ok(Number(res.headers.get('content-length')) > 1000);
});

test('uploaded filenames are generated, never taken from the client', async () => {
  await submit({
    name: 'Path Traversal', phone: '9000000505', file: 'tone_44k.wav',
    filename: '../../../evil.wav',
  });
  const names = readdirSync(process.env.UPLOAD_DIR);
  assert.ok(!names.some((n) => n.includes('evil')), 'client filename reached the disk');
  assert.ok(names.every((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)), 'unexpected filename shape');
});

test('the listing shows submissions with their properties', async () => {
  const res = await fetch(`${base}/submissions`);
  const html = await res.text();
  assert.match(html, /Speech Tester/);
  assert.match(html, /<audio controls/);
  assert.match(html, /kHz/);
});

// ---------------------------------------------------------------------------
// The JSON API the n8n flow uses (Task 2)
// ---------------------------------------------------------------------------

test('GET /api/people?untagged=true returns people with skills and no category', async () => {
  const res = await fetch(`${base}/api/people?untagged=true`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(Array.isArray(rows));
  for (const r of rows) {
    assert.ok(r.person_id && typeof r.skills === 'string' && r.skills.length > 0);
  }
});

test('PATCH /api/people/:id/tag writes a valid category back', async () => {
  const id = db.prepare('SELECT person_id FROM people LIMIT 1').get().person_id;
  const res = await fetch(`${base}/api/people/${id}/tag`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill_category: 'automation-heavy' }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT skill_category c FROM people WHERE person_id=?').get(id).c, 'automation-heavy');
});

test('the API refuses free text from the LLM instead of storing it', async () => {
  const id = db.prepare('SELECT person_id FROM people LIMIT 1').get().person_id;
  for (const bad of ['Sure! The category is automation-heavy.', 'devops', '', 'DROP TABLE people']) {
    const res = await fetch(`${base}/api/people/${id}/tag`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skill_category: bad }),
    });
    assert.equal(res.status, 422, `accepted bad category: ${bad}`);
  }
});

test('tagging a person who does not exist is a 404', async () => {
  const res = await fetch(`${base}/api/people/999999/tag`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill_category: 'data' }),
  });
  assert.equal(res.status, 404);
});
