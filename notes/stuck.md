# Stuck log — raw notes

Notes taken **as I hit each problem**, then tidied into readable entries when I wrote
the README - `git log --follow notes/stuck.md` shows this file growing across the build
and being cleaned up in the final docs commit. The findings are contemporaneous; the
prose is not. The polished three-entry version is in the
[README](../README.md#stuck-log); this file is the fuller record, including the smaller
things that did not make the cut.

---

## 1. Two date separators that disagree about field order

**Blocked on:** `source1_naukri_applicants.csv` has five date formats in `Applied Date`:
`2026-08-08`, `24-07-2026`, `07/13/2026`, `7 Jul 2026`, `19 Jul 2026`. First pass threw
everything at `dayjs(str)` and let it guess. It "worked" — no errors — which is exactly
what made it dangerous.

**Searched:** "dayjs parse ambiguous date format dd/mm vs mm/dd". Most answers say extend
`customParseFormat` and pass a format array, `dayjs(s, ['DD-MM-YYYY','MM/DD/YYYY'], true)`.
Tried it: it silently picks the first format that parses, so for `03-07-2026` whichever
format I listed first decides between 3 July and 7 March. Four months of error, no warning.

**Rejected:**
- Format array with dayjs/moment — order-dependent and silent.
- AI suggested `new Date(str)` — V8 parses `07-03-2026` as US month-first, so every dash
  date lands on the wrong day, and it is implementation-defined.
- AI suggested `dayjs(s,'DD-MM-YYYY')` for everything — throws away `07/13/2026` as invalid.

**Worked:** find a rule the *file* proves. `07/13/2026` can only be MM/DD (no 13th month);
`24-07-2026` can only be DD-MM (no 24th month). So the separator carries the convention.
Strict parsing (`true` third arg) so a mismatch fails loudly. Both-parts-≤-12 cases stay
undecidable, logged at high severity rather than guessed.

**Cost:** ~40 min, mostly convincing myself the format-array approach was wrong.

---

## 2. My own test was wrong, and it caught a real bias

**Blocked on:** test `date: the two separators disagree` failed — expected `2026-03-07`,
got `2026-07-03`.

**Tried:** assumed dayjs was ignoring my format string. Isolated it:
`dayjs('07-03-2026','DD-MM-YYYY',true).format('YYYY-MM-DD')` → `2026-03-07`. Correct. So
the parser was fine and my expectation was wrong.

**Worked:** I had written the assertion for `07/03/2026` as `2026-03-07`, reading it
day-first out of habit — the exact bug the separator rule exists to prevent. Under MM/DD it
is **3 July**. Fixed, and added `assert.notEqual` between the dash and slash versions of the
same digits so the test asserts the conventions genuinely diverge.

**Kept:** an Indian-format reading habit is exactly the bias that makes this column
dangerous, and I proved I have it. That is why ambiguous dates are logged, not converted.

---

## 3. The tier-3 guard was too safe and split a person in half

**Blocked on:** two different Arjun Mehtas both live in Noida, so I guarded tier-3 with
"refuse if more than two clusters share a name+city". Tests passed. Shipped it.

Then I audited the merge output against the raw CSVs. The guard had caused the *opposite*
bug — the second Arjun Mehta was two half-people:

```
person 41  arjun.mehta77@…  rate 42k/month, 6 skills  phone NULL
person 56  +919000000272    verified, 14 projects     email NULL, 0 skills
```

**Insight:** a cluster holding BOTH an email and a phone cannot be the missing half of a
source2↔source3 bridge — it is already whole. Counting it as a rival blocked a good merge.

**Rejected:** just deleting the `clusters.length > 2` term. Over-permissive — a complete
cluster CAN own an extra row via a second email, and this same file has that case
(Nikhil Chopra, one human, two addresses, one phone).

**Worked:** check whether evidence supports the complete cluster's claim, using skills as a
corroborating attribute. Verified the signal before trusting it:
- 15/15 source1↔source2 same-email pairs have byte-identical skill lists
- 0 skill sets shared by two different people (the one apparent collision is
  `R. Verma`/`Rohit Verma` — same person)
- source2:18's skill set appears nowhere in source1

56 → 55 people. Still two Arjun Mehtas, both whole now.

**Kept:** I had treated over-merging as the only failure mode. Under-merging is just as
destructive and much harder to see — nothing looks broken, you just quietly have two half
people. Tests now assert both directions.

---

## 4. Gemini returned an empty string for every person

**Blocked on:** the n8n flow logic ran clean and tagged nobody. All ten came back `null`.
No exception, no HTTP error — it would have looked fine in a demo while doing nothing.

**Tried:** instead of debugging through the n8n UI, ran the same steps in Node and printed
the *whole* response rather than the field I wanted:

```
finishReason: MAX_TOKENS
usage: { candidatesTokenCount: 1, thoughtsTokenCount: 11 }
text: "\n"
```

**Cause:** `gemini-flash-latest` is a thinking model. `maxOutputTokens: 16` was entirely
consumed by internal reasoning before any answer was produced.

**Two more from the same session:** `gemini-2.0-flash` and `gemini-2.5-flash` are retired
for new keys (the 404 body says so), and the endpoint returns `503 UNAVAILABLE` under load —
`flash-latest` needed 4 attempts where `flash-lite-latest` needed 1.

**Rejected:** `thinkingConfig: { thinkingBudget: 0 }` — ignored on `flash-latest`, hard `400`
on `flash-lite`. Raising the budget works on both.

**Settings:** `gemini-flash-lite-latest`, `maxOutputTokens: 512`, retry ×4 with 2 s backoff.

---

## Smaller things, for the record

- **`csv-parse` aborts the whole file on the first malformed row.** `relax_column_count: true`
  is load-bearing — without it all of source2 is lost to one bad row.
- **`skip_empty_lines` deliberately left `false`.** The blank row in source2 is a *finding*.
  Skipping it would have hidden a data issue I am supposed to report.
- **Don't trim on read.** `'Noida '` has to survive the loader so the normaliser can log it.
- **Severity sorted as text** put every high-severity row at the bottom of the CSV report —
  `'high' < 'low' < 'medium'` alphabetically. Needed an explicit `CASE` ordering.
- **`git rebase --exec` re-checks-out files at each commit.** Rewriting commit authors that
  way started mangling the PDF under CRLF rules mid-rebase. `filter-branch --env-filter`
  rewrites metadata only — verified by the tree hash being identical before and after.
- **SNR needs pauses.** A continuous tone has no quiet frames, so the percentile estimate
  collapses to ~0 dB. Found by testing a fixture, not by reasoning about it.
