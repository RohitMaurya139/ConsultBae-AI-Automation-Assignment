# ConsultBae — AI Automation Assignment

Three messy people-databases merged into one, an n8n automation running on top of it, and
a mini audio-collection app that writes back into the same database.

**Stack:** Node.js 20+ · Express · SQLite (`better-sqlite3`) · ffmpeg/ffprobe · n8n · Gemini
No build step, no bundler, no framework. `npm install && npm run pipeline` is the whole setup.

```
102 source rows  ->  55 people          261 data issues logged across 22 types
                                         71 tests, all passing
```

---

## Quick start

Requires **Node.js 20+** (built on Node 22). `ffmpeg` and `ffprobe` do **not** need to be
installed — they ship as npm packages.

```bash
git clone https://github.com/RohitMaurya139/ConsultBae-AI-Automation-Assignment.git
cd ConsultBae-AI-Automation-Assignment

npm install
cp .env.example .env        # add your GEMINI_API_KEY for Task 2

npm run pipeline            # Task 1: build consultbae.db from the 3 CSVs
npm start                   # Task 3: http://localhost:8000
npm test                    # 71 tests
```

| Command | What it does |
|---|---|
| `npm run pipeline` | Rebuilds `consultbae.db`, `DATA_ISSUES.md`, `reports/*`. Idempotent. |
| `npm start` | Audio app on `:8000`, plus the JSON API n8n uses |
| `npm run n8n` | n8n on `:5678` — see [`n8n/README.md`](n8n/README.md) |
| `npm test` | Full suite |

---

## Repo map

| Path | Task | What it is |
|---|---|---|
| `pipeline/` | 1 | Clean → normalise → match → survivorship → SQLite |
| `db/schema.sql` | 1 | 7 tables, including full lineage and a `data_issues` log |
| `n8n/workflow.json` | 2 | 12-node LLM skill-tagging flow |
| `app/` | 3 | Express audio app + the JSON API n8n calls |
| [`DATA_ISSUES.md`](DATA_ISSUES.md) | 4 | **Generated** by the pipeline from the issue log |
| [`SCALE_NOTES.md`](SCALE_NOTES.md) | 5 | 5,000 workers in a weekend, in failure order |
| `reports/` | — | Row-level issue CSV + the human review queue |
| `tests/` | — | 71 tests; audio fixtures are synthesised, not downloaded |

---

## Task 1 — The merge

### The actual problem

**No identifier is common to all three files.**

```
source1 (naukri)   42 rows   name · email · phone · city · experience · CTC · date · skills
source2 (gig)      30 rows   name · email ·   —   · city · rate · status · skills
source3 (cbnexus)  30 rows   name ·   —   · phone · city · verified · projects
```

source2 has **no phone column**. source3 has **no email column**. So source2 and source3 can
never be linked directly — source1 is the only bridge. And for a handful of people who
appear in source2 and source3 but *not* source1, no identifier exists at all.

### Three tiers, strongest first

Union-find over all 102 rows. Every merge records why it happened.

| Tier | Rule | Confidence | Catches |
|---|---|---|---|
| 1 | Same normalised email | high | `R. Verma` / `Rohit Verma` — different names, same address |
| 2 | Same normalised phone | high | One person with **two** email addresses |
| 3 | Same name + city | **medium** | People in source2+source3 with no source1 row |

Tier 3 is deliberately timid, and only fires between a cluster that has an email but no
phone and one that has a phone but no email — i.e. exactly a source2 ↔ source3 bridge.

### The trap, and the guard

**There are two different people called Arjun Mehta, and both live in Noida.** A naive
name+city rule merges them and silently destroys a person.

But the *first* guard I wrote was too blunt, and caused the opposite bug. See
[stuck log #2](#2-the-guard-that-was-too-safe) — it is the most interesting thing in this repo.

### Survivorship

Each system owns the fields it actually manages:

| Fields | Owner |
|---|---|
| experience, CTC, applied date | source1 (the ATS) |
| rate, status, skills | source2 (the gig system) |
| verified, projects completed | source3 (CBNexus) |
| name | most complete variant wins |
| city | majority vote, tie-broken by source priority |

Every disagreement is logged as a `field_conflict`. Nothing is discarded — losing values
stay in `person_sources` as raw JSON, and every identifier ever seen stays in
`person_identifiers`.

### Result

```
102 source rows  ->  55 people   (47 duplicates collapsed)

   27  high            merged on a shared email or phone
    5  medium          merged on name+city, no shared identifier
   23  single-source   appears in one file only

30 people appear in more than one source file
101 identifiers · 102 lineage rows · 15 distinct skills
```

---

## Task 2 — n8n automation

Read untagged people from the merged database → classify each one's skill category with
Gemini → validate → write back → post a Slack/Discord summary.

Full setup and the node-by-node walkthrough: **[`n8n/README.md`](n8n/README.md)**.

SQLite has no n8n node, so rather than switch the project to Postgres for one node, the
Task 3 app exposes a small JSON API over the *same* database. n8n reads and writes the real
merged data, not a copy.

**The LLM is treated as an untrusted input.** The Code node keeps the reply only if it
matches one of five allowed slugs, and `PATCH /api/people/:id/tag` re-validates
server-side — a model answering `"Sure! The category is..."` yields the right slug, and one
inventing `devops` gets a `422`. Tested with four hostile inputs including `DROP TABLE people`.

Verified output:

```
Tanvi Gupta    n8n, LangChain, REST APIs, MongoDB, SQL  -> automation-heavy
Vikram Saxena  SQL, Docker, React, Selenium, Scraping   -> backend
Isha Chopra    JavaScript, React, MySQL                 -> web-dev
```

---

## Task 3 — Audio collection app

```
GET  /             record in the browser (MediaRecorder) or upload a file
POST /submit       store → extract properties → write a row
GET  /submissions  listing with play buttons and every extracted property
GET  /audio/:id    stream a stored recording
```

**Extracted for every submission** — the four the brief requires, plus the bonus:

| Required | Bonus |
|---|---|
| duration, sample rate (kHz), bitrate, loudness (dBFS) | integrated LUFS, peak, noise floor, SNR, clipping %, quality label |

Two tools, because neither is enough alone: **ffprobe** for container metadata (bitrate is a
property of the *encoding* and cannot be computed from decoded samples) and **ffmpeg** to
decode raw PCM for the signal measurements. Bitrate falls back to `size×8/duration` when the
container declares none — the common case for the WebM/Opus that MediaRecorder produces.

**Submissions link into the same database by phone**, reusing the pipeline's own normaliser,
so `+91 90000 00287` finds the merged Priya Singh record built from source1 + source3. An
unknown number creates a person rather than orphaning the row.

The recorded Blob is injected into the form's file input via `DataTransfer`, so recording and
uploading take the identical server path instead of two.

### How the audio numbers were verified

Fixtures are **synthesised with known properties** (`tests/fixtures/generate.js`) rather than
downloaded, so the correct answer is known independently of the code:

- 44.1 kHz / 16-bit / stereo WAV reads back as **exactly 1411.2 kbps**
- RMS and peak agree with `ffmpeg volumedetect` to within **0.04 dB**
- peak sits **3.01 dB** above RMS for a sine, as the maths requires
- quiet room **31.9 dB SNR → "good"**, loud room **4.6 dB → "noisy"**

**One honest limitation.** The SNR estimate is the gap between the loudest and quietest tenth
of 20 ms frames, which only means "signal vs background" when the recording contains pauses.
A continuous tone has none, so the gap collapses to ~0 dB. That is absence of evidence, not
evidence of noise — so continuous audio is labelled `unknown (no pauses)` rather than
falsely reported as noisy. I found this by testing, not by reasoning.

---

## Task 4 — Data issues

**[`DATA_ISSUES.md`](DATA_ISSUES.md) is generated by the pipeline**, not written by hand.
Every count, line number and example comes from the same run that built the database, so the
report cannot drift from what the code does.

```
261 issues · 22 distinct types
  34 high     would corrupt data or lose a person if unhandled
  32 medium   a judgement call that could reasonably go the other way
 195 low      cosmetic or formatting
```

Highlights: columns rotated by one position, a header line repeated mid-file, two units in
one salary column, five date formats where the two separators disagree about field order,
one person holding two email addresses, and two different people sharing a name *and* a city.

It also has a **"what is NOT a data issue"** section, because several things look like
defects and are not.

---

## Task 5 — Scale

**[`SCALE_NOTES.md`](SCALE_NOTES.md)** — 5,000 workers over one weekend, in the order things
break. Synchronous ffmpeg on the request path fails first; then ephemeral disk and SQLite's
write lock; then uploads transiting the web process. Under $20 in cost — the real risk is
unbounded retention, not compute.

---

## Stuck log

The three places I actually lost time, what I searched, and what I rejected.
Raw notes as they happened: [`notes/stuck.md`](notes/stuck.md).

### 1. Two date separators that disagree about field order

**Blocked on.** `source1` has five date formats in one column: `2026-08-08`, `24-07-2026`,
`07/13/2026`, `7 Jul 2026`, `19 Jul 2026`. My first pass threw everything at `dayjs(str)` and
let it guess. It *worked* — no errors — which is exactly what made it dangerous.

**What I searched.** "dayjs parse ambiguous date format dd/mm vs mm/dd". Most answers say
extend `customParseFormat` and pass a format array: `dayjs(s, ['DD-MM-YYYY','MM/DD/YYYY'], true)`.

**What I rejected, and why.**
- **The format-array approach.** It picks the first format that parses, so for `03-07-2026`
  whichever format I happened to list first decides whether it is 3 July or 7 March. A
  four-month error with no warning, and the wrong answer is indistinguishable from the right one.
- **`new Date(str)`** (suggested by AI). V8 parses `07-03-2026` as US month-first, so every
  dash date in the file lands on the wrong day — and it is implementation-defined, so it could
  differ on another machine.
- **`dayjs(s, 'DD-MM-YYYY')` for everything** (also suggested). Throws away `07/13/2026` as
  invalid, because there is no 13th month.

**What worked.** I stopped trying to infer per-value and looked for a rule the *file itself*
proves. Two rows settle it: `07/13/2026` can only be MM/DD, and `24-07-2026` can only be DD-MM.
So the **separator** carries the convention — slash = US order, dash = day-first — with strict
parsing so a mismatch fails loudly. Values where both parts are ≤ 12 stay genuinely undecidable,
so they are logged at high severity rather than quietly converted.

**The part I nearly missed.** My own test then failed. I assumed the parser was wrong; it
wasn't. I had written the expectation for `07/03/2026` as 7 March, reading it day-first out of
habit — the exact bias the separator rule exists to prevent. Under MM/DD it is **3 July**. I
had proved I have the bug the rule guards against, which is why ambiguous dates are flagged
instead of silently converted.

**Cost:** ~40 minutes.

### 2. The guard that was too safe

**Blocked on.** The dataset contains two different people called Arjun Mehta who both live in
Noida. My tier-3 rule matches on name + city, so I wrote a guard: refuse to merge if more than
two clusters share a name+city. It worked — the two Arjun Mehtas stayed separate, my test
passed, and I shipped it.

Then I audited the merge output against the raw CSVs and found the guard had caused the
*opposite* bug. The second Arjun Mehta was split into two half-people:

```
person 41   arjun.mehta77@…   rate 42k/month, 6 skills   phone: NULL
person 56   +919000000272     verified, 14 projects      email: NULL, 0 skills
```

Neither row could be both emailed and phoned. The person I was most careful about is the one
I quietly duplicated.

**The insight.** A cluster that already holds **both** an email and a phone cannot be the
missing half of a source2↔source3 bridge — it is already whole. Counting it as a rival
candidate blocked a correct merge.

**What I rejected.** Simply deleting the `clusters.length > 2` term. That is over-permissive:
a complete cluster *can* legitimately own an extra row via a second email address, and **this
same file contains exactly that case** — Nikhil Chopra, one human with two addresses on one
phone. The purely structural argument is incomplete.

**What worked.** Before treating a complete cluster as a rival claimant, check whether any
evidence supports the claim, using skills as a corroborating attribute. I verified that signal
before relying on it rather than assuming it:

- **15/15** source1↔source2 pairs sharing an email have byte-identical skill lists
- **0** skill sets are shared by two *different* people (the one apparent collision is
  `R. Verma`/`Rohit Verma` — same person, same email)
- `source2:18`'s skill set appears **nowhere** in source1, so that Arjun Mehta has no source1
  record at all

So the complete cluster is ruled out, the merge proceeds, and the rejected alternative is
written into the issue log. **56 → 55 people.** Still two Arjun Mehtas — but both are whole now.

**What I took from it.** I had been treating "don't over-merge" as the only failure mode.
Under-merging is just as destructive and much harder to see, because nothing looks broken —
you just quietly have two half-people. The test now asserts *both* directions: exactly two
Arjun Mehtas, and the second one has his rate, his verification, and his skills.

### 3. Gemini returned an empty string for every single person

**Blocked on.** The n8n flow's logic ran end-to-end with no errors and tagged **nobody**. Every
one of ten people came back `null` and was skipped. No exception, no HTTP error — the flow
would have looked like it worked in a demo while doing nothing.

**What I did.** Rather than debug through the n8n UI, I ran the same steps directly against the
API in Node and printed the *whole* response instead of the field I wanted. That surfaced it
immediately:

```
finishReason: MAX_TOKENS
usage: { candidatesTokenCount: 1, thoughtsTokenCount: 11 }
text: "\n"
```

**The cause.** `gemini-flash-latest` is a **thinking model**. I had set `maxOutputTokens: 16`
because I only wanted one word back — but 11 of those tokens went to internal reasoning before
any answer was produced, so the reply was truncated to a newline.

**Two more problems fell out of the same investigation.** `gemini-2.0-flash` and
`gemini-2.5-flash` are both retired for new API keys (the 404 body says so). And the endpoint
intermittently returns `503 UNAVAILABLE` under load — `flash-latest` needed four attempts where
`flash-lite-latest` needed one.

**What I rejected.** Setting `thinkingConfig: { thinkingBudget: 0 }` to disable reasoning. It is
ignored on `flash-latest` and returns a hard `400` on `flash-lite`. Raising the token budget is
the fix that actually works on both.

**Final settings, each one earned:** `gemini-flash-lite-latest`, `maxOutputTokens: 512`,
`retryOnFail` ×4 with 2 s backoff. None of these would have been visible until the flow silently
did nothing mid-demo.

---

## Testing

```
71 tests    node --test, no framework
```

| Suite | Covers |
|---|---|
| `normalize.test.js` | Every input string copied verbatim from the source CSVs |
| `clean.test.js` | The three structural defects, asserted by real line number |
| `match.test.js` | Each planted trap by name, both merge directions |
| `audio.test.js` | Metrics against fixtures with independently known values |
| `app.test.js` | HTTP round-trips, including a path-traversal attempt |

Tests run against the **real files**, not invented data. `tests/match.test.js` names each trap
in the test title, so a failure says which one broke.

---

## What I would do next, with more time

- **Async analysis.** The first thing in `SCALE_NOTES.md`, and the first thing I would build.
- **A confidence score rather than three labels.** `high`/`medium`/`single-source` is coarse;
  a numeric score from agreeing attributes would let the review threshold be tuned.
- **Use skills as a matching signal, not just a tie-breaker.** The fingerprint turned out to be
  100% precise on this dataset — it currently only rules candidates *out*.
- **A UI for the review queue.** It is a JSON file. Two buttons would make it usable.
