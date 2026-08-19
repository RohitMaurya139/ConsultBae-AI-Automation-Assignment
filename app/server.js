/**
 * Task 3 - mini audio collection app.   npm start
 *
 *   GET  /                      submit form: name, phone, record or upload
 *   POST /submit                stores the audio, extracts properties, writes a row
 *   GET  /submissions           listing with a play button and every extracted property
 *   GET  /audio/:id             streams a stored file
 *
 * The same server also exposes the small JSON API that the Task 2 n8n flow calls,
 * because SQLite has no n8n node. One server, one schema, no duplicated DB logic.
 *
 *   GET   /api/people?untagged=true    people with skills but no category yet
 *   PATCH /api/people/:id/tag          write the LLM's category back
 *   GET   /api/stats                   counts, used for the Slack summary
 */

import { existsSync, mkdirSync, createReadStream, statSync } from 'node:fs';
import { extname, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import 'dotenv/config';

import { analyzeAudio } from './audio.js';
import {
  findOrCreatePerson, insertSubmission, listSubmissions, getSubmission,
  listAllPeople, listUntaggedPeople, setSkillCategory, stats,
} from './db.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPLOAD_DIR = resolve(ROOT, process.env.UPLOAD_DIR ?? 'app/uploads');
const PORT = Number(process.env.PORT ?? 8000);
const MAX_UPLOAD_MB = 25;

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

/** Accepted containers. Kept broad because browsers differ on what they record. */
const ALLOWED = new Set([
  'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac',
  'video/webm',   // Chrome labels MediaRecorder output video/webm even with no video track
]);

const EXT_FOR = {
  'audio/webm': '.webm', 'video/webm': '.webm', 'audio/ogg': '.ogg',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Never trust the client's filename on disk - it is attacker-controlled.
    // Keep the original separately in the database for display only.
    const ext = EXT_FOR[file.mimetype] ?? extname(file.originalname).slice(0, 6) ?? '.bin';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${stamp}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported audio type: ${file.mimetype}`));
  },
});

const app = express();
app.set('view engine', 'ejs');
app.set('views', resolve(ROOT, 'app/templates'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(resolve(ROOT, 'app/static')));

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => res.render('submit', { stats: stats(), result: null, error: null }));

app.get('/submissions', (_req, res) =>
  res.render('submissions', { rows: listSubmissions(), stats: stats() }));

/** Stream a stored recording. */
app.get('/audio/:id', (req, res) => {
  const row = getSubmission(Number(req.params.id));
  if (!row) return res.status(404).send('Not found');

  // Resolve against UPLOAD_DIR and keep only the basename, so a stored path can
  // never walk out of the uploads directory.
  const path = resolve(UPLOAD_DIR, basename(row.file_path));
  if (!path.startsWith(UPLOAD_DIR) || !existsSync(path)) return res.status(404).send('File missing');

  const { size } = statSync(path);
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', size);
  res.setHeader('Accept-Ranges', 'bytes');
  createReadStream(path).pipe(res);
});

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

app.post('/submit', (req, res) => {
  upload.single('audio')(req, res, async (uploadErr) => {
    const fail = (msg) => res.status(400).render('submit', { stats: stats(), result: null, error: msg });

    if (uploadErr) {
      return fail(uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than ${MAX_UPLOAD_MB} MB.`
        : uploadErr.message);
    }

    const name = String(req.body.name ?? '').trim();
    const phone = String(req.body.phone ?? '').trim();
    if (!name) return fail('Name is required.');
    if (!phone) return fail('Phone number is required.');
    if (!req.file) return fail('Record something or choose an audio file first.');

    try {
      // Analysis is the slow part, but it must finish before we reply so the
      // listing never shows a row with empty properties.
      const props = await analyzeAudio(req.file.path);
      const { personId, created, normalisedPhone } = findOrCreatePerson({ name, phone });

      const submissionId = insertSubmission({
        person_id: personId,
        submitted_name: name,
        submitted_phone: normalisedPhone ?? phone,
        file_path: req.file.filename,
        original_name: req.file.originalname,
        mime_type: req.file.mimetype,
        size_bytes: props.size_bytes ?? req.file.size,
        duration_sec: props.duration_sec,
        sample_rate_hz: props.sample_rate_hz,
        bitrate_kbps: props.bitrate_kbps,
        loudness_dbfs: props.loudness_dbfs,
        channels: props.channels,
        codec: props.codec,
        peak_dbfs: props.peak_dbfs,
        loudness_lufs: props.loudness_lufs,
        noise_floor_dbfs: props.noise_floor_dbfs,
        snr_db: props.snr_db,
        clipping_pct: props.clipping_pct,
        quality_label: props.quality_label,
        analysis_error: props.analysis_error,
      });

      res.render('submit', {
        stats: stats(),
        error: null,
        result: { submissionId, props, personId, created, phone: normalisedPhone ?? phone, name },
      });
    } catch (e) {
      console.error('submit failed:', e);
      fail(`Could not process that recording: ${e.message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// JSON API - this is what the n8n flow talks to (Task 2)
// ---------------------------------------------------------------------------

app.get('/api/people', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  // ?untagged=true is what the n8n flow sends, so it only ever pulls work it
  // still has to do. Without the flag this lists everyone, tagged or not.
  res.json(req.query.untagged === 'true' ? listUntaggedPeople(limit) : listAllPeople(limit));
});

app.patch('/api/people/:id/tag', (req, res) => {
  const ALLOWED_CATEGORIES = ['automation-heavy', 'web-dev', 'data', 'qa-automation', 'backend'];
  const category = String(req.body?.skill_category ?? '').trim();

  // Never write free text from an LLM straight into the database.
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return res.status(422).json({ error: 'invalid category', allowed: ALLOWED_CATEGORIES, received: category });
  }
  const changed = setSkillCategory(Number(req.params.id), category);
  if (!changed) return res.status(404).json({ error: 'no such person' });
  res.json({ person_id: Number(req.params.id), skill_category: category });
});

app.get('/api/stats', (_req, res) => res.json(stats()));
app.get('/api/submissions', (_req, res) => res.json(listSubmissions()));

// ---------------------------------------------------------------------------

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n  audio collection app  ->  http://localhost:${PORT}`);
    console.log(`  submissions listing   ->  http://localhost:${PORT}/submissions`);
    console.log(`  uploads directory     ->  ${UPLOAD_DIR}\n`);
  });
}

export default app;
