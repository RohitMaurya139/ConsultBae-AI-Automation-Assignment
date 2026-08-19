# Task 2 — n8n automation

**Flow:** read people from the merged Task 1 database → ask an LLM to classify each
one's skill category → validate the reply → write it back → post a summary alert.

`workflow.json` is the export. Import it into n8n with **Workflows → ⋯ → Import from File**.

---

## Why this talks to an HTTP API

SQLite has no n8n node. Rather than switch the whole assignment to Postgres just to
get one, the Task 3 Express app exposes a small JSON API over the *same* database:

| Endpoint | Used by |
|---|---|
| `GET /api/people?untagged=true` | "Get untagged people" |
| `PATCH /api/people/:id/tag` | "Write category back" |
| `GET /api/stats` | "Get final stats" |

One server, one schema, no duplicated database logic — and n8n is reading and writing
the real merged data, not a copy.

---

## Setup

**1. Start the app** (it is the data source):

```bash
npm start          # http://localhost:8000
```

**2. Start n8n:**

```bash
npm run n8n        # http://localhost:5678
```

**3. Create the Gemini credential.** In n8n: **Credentials → New → Header Auth**

| Field | Value |
|---|---|
| Name | `Gemini API Key` |
| Header Name | `x-goog-api-key` |
| Header Value | *your key from `.env`* |

> Must be **Header Auth**, not Bearer — Gemini returns `401` for `Authorization: Bearer`.
> The credential is deliberately *not* in `workflow.json`, so no key is committed to git.

**4. Import `workflow.json`**, open the **Post summary alert** node, and paste a Slack or
Discord incoming-webhook URL. The body sends both `text` (Slack) and `content` (Discord),
so either works.

**5. Click Execute workflow.**

---

## The nodes

```
Manual trigger
  → Config                    apiBaseUrl, model, batch limit in one place
  → Get untagged people       GET /api/people?untagged=true
  → Loop over people          one person per iteration
       → Gemini classify      POST generateContent, retry x4 on 503
       → Validate category    reject anything not in the allow-list
       → Usable category?     IF
            true  → Write category back    PATCH /api/people/:id/tag
            false → Skip                   no write, loop continues
  → (loop done)
  → Get final stats           GET /api/stats
  → Build summary
  → Post summary alert        Slack / Discord webhook
```

### Two guards worth pointing at

**The LLM's output is never trusted.** "Validate category" strips punctuation and keeps
the reply only if it matches one of five allowed slugs. A model that answers
*"Sure! The category is automation-heavy."* still yields `automation-heavy`; one that
invents `devops` yields `null` and is skipped.

**The API re-validates.** `PATCH /api/people/:id/tag` checks the same allow-list
server-side and returns `422` for anything else, so a broken flow cannot write junk
into the database. Tested with four hostile inputs including `DROP TABLE people`.

---

## Things that broke while building this, and why the settings are what they are

| Symptom | Cause | Fix |
|---|---|---|
| Every reply came back empty, so every person was skipped | `gemini-flash-latest` is a *thinking* model. With `maxOutputTokens: 16`, all 11 tokens went to internal reasoning and `finishReason` was `MAX_TOKENS` | `maxOutputTokens: 512` |
| `404` from the API | `gemini-2.0-flash` and `gemini-2.5-flash` are both retired for new keys | `gemini-flash-lite-latest` |
| Intermittent `503 UNAVAILABLE` | Endpoint overloads under demand; `flash-latest` needed 4 attempts where `flash-lite-latest` needed 1 | `retryOnFail`, 4 tries, 2 s backoff |
| `400 invalid argument` | `flash-lite` rejects `thinkingConfig` | dropped it |
| `SQLITE_CONSTRAINT: NOT NULL constraint failed: workflow_entity.id` on import, **and n8n still exits 0** | the export had no top-level `id` | added `id`, `active` and `versionId` |

## Verified output

```
  1  Tanvi Gupta    | n8n, LangChain, REST APIs, MongoDB, SQL   -> automation-heavy
  3  Priya Singh    | n8n, SQL, Zapier, React, MySQL, Python    -> automation-heavy
  4  Vikram Saxena  | SQL, Docker, React, Selenium, Scraping    -> backend
  8  Isha Chopra    | JavaScript, React, MySQL                  -> web-dev
```

## If n8n will not run locally

Use the n8n **cloud trial** (the brief allows it), expose the app with
`ngrok http 8000`, and change `apiBaseUrl` in the **Config** node to the ngrok URL.
Nothing else changes.

---

## Verified against n8n 2.22.6

```
$ n8n import:workflow --input=n8n/workflow.json
Importing 1 workflows...
Successfully imported 1 workflow.
```

All 12 nodes and all 11 connections survive the import with their type-versions intact,
so the 1.x node versions in this export are accepted by n8n 2.x.
