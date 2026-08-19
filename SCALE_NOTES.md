# Task 5 — 5,000 gig workers, one weekend

What breaks first, in the order it breaks, and what I would change before opening the door.

---

## The shape of the load

5,000 workers over a weekend is not 5,000 evenly spaced requests. Gig cohorts are told to
submit at once, so expect roughly half the volume in two or three spikes of a few hours —
call it **~15 submissions/minute sustained, 100+/minute at peak**.

At 60 seconds of speech per person that is about **5,000 files and 3–8 GB** of audio,
depending on codec.

---

## 1. Analysis blocks the request — this breaks first

Today `POST /submit` runs three ffmpeg processes (probe, PCM decode, EBU R128) **before**
replying. Measured at **250–400 ms** per file locally, and ffmpeg is CPU-bound, so on a
single free-tier core it serialises. At 100 submissions/minute the queue grows without
bound and uploads start timing out — while the worker is still holding their phone,
assuming it failed, and pressing submit again.

**Change:** store the file, write the row with `status = 'pending'`, return `202`
immediately. Move analysis to a worker consuming a queue (BullMQ + Redis, or SQS). The
submissions view already tolerates missing metrics, so a row that is analysed thirty
seconds later needs no UI change. Cap concurrency at roughly the core count.

This one change is worth more than everything below it.

---

## 2. SQLite is the wrong database the moment there are two processes

`better-sqlite3` in WAL mode handles concurrent reads fine, but writes take a global lock,
and the file has to live on a disk both the web process and the worker can see. The instant
I add a queue worker, or a second web dyno, SQLite stops being viable.

Worse, on Render/Railway free tiers the disk is **ephemeral** — a redeploy or idle restart
silently destroys every upload and the database with it.

**Change:** Postgres (Neon/Supabase free tier is enough for 5,000 rows), and audio to
object storage — S3 or Cloudflare R2 — never the app's local disk. The schema ports
essentially as-is; only the `INTEGER PRIMARY KEY` and the `datetime('now')` defaults change.

---

## 3. Uploads go through the app for no reason

Every byte currently transits the web process, which means a 25 MB upload occupies a
connection for its whole duration. On a mobile network that can be minutes. A few hundred
concurrent uploads exhausts the connection pool, and a dropped connection loses the whole
file with no resume.

**Change:** presigned direct-to-S3 uploads. The browser gets a URL, uploads straight to
storage, then posts only the object key to the API. The app never touches the bytes, and
S3 handles retry and multipart resume. This also removes the 25 MB cap as a scaling
concern.

---

## 4. Duplicate submissions, which this dataset already proves are inevitable

The merge pipeline exists precisely because the same human shows up under three different
identities. A public form makes that worse, not better: people submit twice because the
first attempt seemed to hang (see #1), type their number five different ways, or share a
phone with a family member.

Right now `findOrCreatePerson` normalises the phone and matches on it — good — but there is
nothing stopping the same person submitting ten recordings.

**Change:**
- Idempotency key per submission attempt so a retried POST does not create a second row.
- Rate limit per phone number, not per IP — gig workers share hotspots and cafés, so
  IP limiting punishes exactly the wrong people.
- Decide the product rule explicitly: is a second recording an *update* or an *additional*
  submission? Today it is additional. At 5,000 workers someone must answer this before
  launch, not after.
- OTP-verify the phone before accepting audio. Without it the phone number — the join key
  for the entire database — is unverified user input.

---

## 5. Failure handling is currently "hope"

`analysis_error` is stored, which is the right instinct, but nothing retries and nobody is
told. At 5,000 submissions even a 1% failure rate is 50 workers whose recording is silently
useless, discovered days later when someone reads the table.

**Change:** dead-letter queue with bounded retries, a `status` column
(`pending / analysed / failed`), an admin view filtered to failures, and one alert when the
failure rate crosses a threshold. Reuse the existing n8n flow for the alert — it already
posts to Slack.

---

## 6. Cost — small, but only if storage is bounded

| Item | Weekend estimate |
|---|---|
| Object storage, 8 GB | ~$0.20/month on R2 (no egress fees) |
| Postgres, 5k rows | free tier |
| Web + 2 workers | ~$15/month on Railway/Fly |
| Gemini tagging, 5k calls | ~$0.50 on flash-lite |
| **Total** | **under $20 for the weekend** |

Compute is not the risk. **Unbounded retention is.** 8 GB per campaign, run monthly,
becomes 100 GB in a year for data nobody looks at after the first week. Set a lifecycle
rule at day one — transition to cold storage at 30 days, delete at 90 unless flagged.

---

## 7. What I would not bother with

- **Autoscaling.** Two workers on a fixed box absorb this load. Autoscaling adds cold
  starts and failure modes for a weekend event.
- **A CDN.** Playback is internal-review traffic, a handful of people, not 5,000.
- **Rewriting the analyser.** 250–400 ms is fine once it is off the request path. Optimising
  before moving it would be solving the wrong problem.

---

## Before I would open it to 5,000 people

In priority order. The first three are non-negotiable.

1. **Async analysis** — return `202`, analyse on a queue. Fixes the actual first failure.
2. **Object storage + Postgres** — ephemeral disk means guaranteed data loss on redeploy.
3. **Presigned direct uploads** — keeps the bytes out of the web process.
4. **OTP on the phone number** — it is the join key for the whole database and is currently
   unverified.
5. **Idempotency + per-phone rate limiting** — duplicates are certain, not hypothetical.
6. **Retry, status column, failure alert** — so a 1% failure rate is visible in minutes.
7. **Storage lifecycle policy** — before the first campaign, not after the tenth.

**A load test with 200 concurrent uploads would tell me more than any of this reasoning.**
I would run that first and let it re-order the list.
