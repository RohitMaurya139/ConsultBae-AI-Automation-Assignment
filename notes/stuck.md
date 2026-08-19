# Stuck log

Written **as it happened**, not reconstructed at the end.
Format: what blocked me -> what I tried -> what I rejected and why -> what worked.

---

## 1. Two date separators in one column that disagree about field order

**Blocked on:** `source1_naukri_applicants.csv` has five date formats in `Applied Date`:
`2026-08-08`, `24-07-2026`, `07/13/2026`, `7 Jul 2026`, `19 Jul 2026`. My first pass just
threw everything at `dayjs(str)` and let it guess. It "worked" - no errors - which is
exactly what made it dangerous.

**What I tried / searched:** searched "dayjs parse ambiguous date format dd/mm vs mm/dd".
Most answers say pass `dayjs.extend(customParseFormat)` and give a format array like
`dayjs(s, ['DD-MM-YYYY','MM/DD/YYYY'], true)`. I tried that and it silently picks the
first format that parses, which for `03-07-2026` means whichever I happened to list first
decides whether it is 3 July or 7 March. Four months of error, no warning.

**Suggestions I rejected:**
- **Format array with dayjs / `moment`** - rejected. Order-dependent and silent. The
  wrong answer is indistinguishable from the right one.
- **AI suggested "just use `new Date(str)`"** - rejected. V8 parses `07-03-2026` as
  US month-first, so every dash date in the file would land on the wrong day, and it
  is implementation-defined so it could differ on another machine.
- **AI suggested `dayjs(s, 'DD-MM-YYYY')` for everything** - rejected. Would throw away
  `07/13/2026` (no 13th month) as invalid.

**What actually worked:** I stopped trying to infer per-value and looked for a rule the
*file itself* proves. Two rows settle it:
- `07/13/2026` can only be MM/DD - there is no 13th month.
- `24-07-2026` can only be DD-MM - there is no 24th month.
So the **separator** carries the convention: slash = US order, dash = day-first. I branch
on separator with strict parsing (`true` as the third arg) so a mismatch fails loudly
instead of falling back. Values where both parts are <= 12 are still genuinely undecidable
from the data alone, so those get logged as `date_ambiguous` at **high** severity - the
pipeline states its assumption rather than hiding it.

**Cost:** ~40 min, mostly spent convincing myself the format-array approach was wrong.

---

## 2. My own test was wrong, and it caught a real misunderstanding

**Blocked on:** test `date: the two separators disagree about field order` failed:
expected `2026-03-07`, got `2026-07-03`.

**What I tried:** first instinct was that `dayjs` was ignoring my `DD-MM-YYYY` format
string. I isolated it: `dayjs('07-03-2026','DD-MM-YYYY',true).format('YYYY-MM-DD')` ->
`2026-03-07`. Correct. So the parser was fine and my expectation was wrong.

**What actually worked:** I had written the assertion for `07/03/2026` as `2026-03-07`,
reading it day-first out of habit - the exact bug the separator rule exists to prevent.
Under MM/DD it is **3 July**, not 7 March. Fixed the assertion and added
`assert.notEqual(...)` between the dash and slash versions of the same digits, so the test
now asserts the two conventions genuinely diverge rather than just checking two constants.

**Takeaway I kept:** an Indian-format habit is exactly the bias that makes this column
dangerous, and I proved I had it. That is why the ambiguous cases are logged rather than
silently converted.

---

## 3.

_(in progress - identity matching)_
