# ConsultBae — AI Automation Assignment

Merging three messy people-databases into one clean database, automating on top of it
with n8n, and a mini audio-collection app that writes back into the same database.

> **Status:** in progress. See commit history for the build order.

---

## Stack

Node.js 20+ · Express · SQLite (`better-sqlite3`) · ffmpeg/ffprobe · n8n

No build step, no bundler, no framework. `npm install && npm run pipeline` is the whole setup.

---

## What's here

| Path | Task | What it is |
|---|---|---|
| `pipeline/` | 1 | Ingest + normalize + identity-resolve the 3 CSVs into one SQLite DB |
| `n8n/workflow.json` | 2 | Exported low-code automation flow |
| `app/` | 3 | Express audio collection app (record/upload + metrics + listing view) |
| `DATA_ISSUES.md` | 4 | Every data-quality problem found, and what was done about it |
| `SCALE_NOTES.md` | 5 | Launching to 5,000 gig workers in one weekend — what breaks first |
| `data/raw/` | — | The 3 source CSVs, unmodified |
| `db/schema.sql` | — | Database schema |

---

## Setup

Requires **Node.js 20+** (built and tested on Node 22).

```bash
git clone https://github.com/RohitMaurya139/ConsultBae-AI-Automation-Assignment.git
cd ConsultBae-AI-Automation-Assignment

npm install
cp .env.example .env
```

`ffmpeg` and `ffprobe` do **not** need to be installed — they ship as npm packages
(`ffmpeg-static`, `ffprobe-static`).

### Task 1 — build the merged database

```bash
npm run pipeline
```

Creates `consultbae.db` and `reports/data_issues.csv`. The run is idempotent — safe to re-run.

### Task 3 — run the audio app

```bash
npm start
```

- `http://localhost:8000/` — submit a recording
- `http://localhost:8000/submissions` — all submissions with extracted audio properties

### Task 2 — run the automation

```bash
npm run n8n     # starts n8n on http://localhost:5678
```

Then import `n8n/workflow.json`. The app must be running (`npm start`) so n8n can
reach the database over HTTP.

---

## Data issues report

See [`DATA_ISSUES.md`](DATA_ISSUES.md).

## How people are matched

_(to be written — see `pipeline/match.js`)_

## Stuck log

See [`notes/stuck.md`](notes/stuck.md) — kept live while building, not reconstructed afterwards.
