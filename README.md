# ConsultBae — AI Automation Assignment

Merging three messy people-databases into one clean database, automating on top of it
with n8n, and a mini audio-collection app that writes back into the same database.

> **Status:** in progress. See commit history for the build order.

---

## What's here

| Path | Task | What it is |
|---|---|---|
| `pipeline/` | 1 | Ingest + normalize + identity-resolve the 3 CSVs into one SQLite DB |
| `n8n/workflow.json` | 2 | Exported low-code automation flow |
| `app/` | 3 | FastAPI audio collection app (record/upload + metrics + listing view) |
| `DATA_ISSUES.md` | 4 | Every data-quality problem found, and what was done about it |
| `SCALE_NOTES.md` | 5 | Launching to 5,000 gig workers in one weekend — what breaks first |
| `data/raw/` | — | The 3 source CSVs, unmodified |
| `db/schema.sql` | — | Database schema |

---

## Setup

Requires Python 3.11+.

```bash
git clone https://github.com/RohitMaurya139/ConsultBae-AI-Automation-Assignment.git
cd ConsultBae-AI-Automation-Assignment

python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
cp .env.example .env
```

### Task 1 — build the merged database

```bash
python -m pipeline.run
```

Creates `consultbae.db` and `reports/data_issues.csv`. The run is idempotent — safe to re-run.

### Task 3 — run the audio app

```bash
uvicorn app.main:app --reload
```

- `http://localhost:8000/` — submit a recording
- `http://localhost:8000/submissions` — all submissions with extracted audio properties

### Task 2 — run the automation

```bash
docker run -it --rm -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
```

Then import `n8n/workflow.json` at `http://localhost:5678`.

---

## Data issues report

See [`DATA_ISSUES.md`](DATA_ISSUES.md).

## How people are matched

_(to be written — see `pipeline/match.py`)_

## Stuck log

See [`notes/stuck.md`](notes/stuck.md) — kept live while building, not reconstructed afterwards.
