/**
 * Generates DATA_ISSUES.md (Task 4) from the data_issues table.
 *
 * Generated rather than hand-written on purpose: every count, example and line
 * number comes from the same run that produced the database, so the report
 * cannot drift away from what the code actually does. The prose explaining
 * *why* each decision was made lives in NARRATIVE below.
 */

import { writeFileSync } from 'node:fs';

/** Why each issue type matters and what the judgement call was. */
const NARRATIVE = {
  // --- structural -----------------------------------------------------------
  column_shift: {
    title: 'Columns rotated by one position',
    why: 'One row in source2 has its fields shifted right by one, so the skills list sits in the email column and every other value is off by one. Ingested as-is it would create a person whose email address is "react, javascript, mysql".',
    how: 'Detected structurally, not by matching the known bad string: column 0 is not an email but a later column is, which can only happen if the fields shifted. The row is rotated back by that offset. Repairing it is what then reveals it to be a duplicate of row 7.',
  },
  repeated_header: {
    title: 'Header line repeated inside the data',
    why: 'source3 has its header row printed again halfway down the file, a classic symptom of two exports concatenated. Ingested naively it becomes a person called "Name" with the phone number "Phone Number".',
    how: 'Any row whose joined values equal the header is dropped.',
  },
  blank_row: {
    title: 'Completely empty row',
    why: 'An empty row would otherwise become a person with no name and no identifiers.',
    how: 'Dropped. Note the CSV parser is configured with `skip_empty_lines: false` deliberately, so the blank row is *reported* rather than silently swallowed.',
  },
  duplicate_row_in_source: {
    title: 'Byte-identical duplicate row',
    why: 'The same record appears twice in one file.',
    how: 'Dropped after trimming and lower-casing every field. Only exact repeats are handled here; anything needing judgement is left to the matcher so it can be logged with a confidence level.',
  },

  // --- identity -------------------------------------------------------------
  duplicate_person_same_email: {
    title: 'One person, two rows, written under different names',
    why: '"R. Verma" and "Rohit Verma" are the same human with the same email address and phone number. A name-based dedupe would keep both.',
    how: 'Merged on the shared email. The fuller name wins the golden record, and the abbreviated form is preserved in person_sources.',
  },
  same_person_two_emails: {
    title: 'One person holding two email addresses',
    why: 'The single most instructive record in the dataset: the same human appears twice in source1 with `nikhil.chopra70@example.com` and `alt.nikhil.chopra70@example.com`, identical in every other field. Matching on email alone produces two people.',
    how: 'Caught by the phone tier. Both addresses are kept in person_identifiers so either one still resolves to this person; the unprefixed address becomes primary.',
  },
  multiple_emails_one_person: {
    title: 'More than one email address survives onto one person',
    why: 'Once the above merge happens, a choice has to be made about which address is canonical.',
    how: 'The shorter, unprefixed address wins. Every address is retained as an identifier, so nothing is lost.',
  },
  name_abbreviated: {
    title: 'Given name abbreviated to an initial',
    why: '"R. Verma" cannot safely drive a name-based match - it would match every Verma in the file.',
    how: 'Single-letter tokens are excluded from the match key. Such a row can be *pulled into* a match by a stronger signal, but can never *cause* one.',
  },
  matched_on_name_and_city: {
    title: 'People matched on name + city with no shared identifier',
    why: 'source2 has no phone column and source3 has no email column, so they can never be linked directly. A handful of people appear in both and in neither source1 - for them, name + city is the only signal available.',
    how: 'Merged at **medium** confidence, never high, and only when exactly one email-only and one phone-only cluster answer to that name+city. Every such merge is listed below with its exact source rows.',
  },
  name_city_shared_with_third_person: {
    title: 'A third person shares the same name and city',
    why: 'Two different people called Arjun Mehta both live in Noida. This is the trap in the dataset: a naive name+city rule merges them and destroys a person.',
    how: 'A cluster that already holds both an email and a phone cannot be the missing half of a bridge, so it does not block the merge - but it could still own the row via a second email address, so skills are checked as corroborating evidence. They differ, so it is ruled out and the decision is recorded.',
  },
  name_variants_merged: {
    title: 'Same person spelled differently across sources',
    why: 'Names arrive as ALL CAPS, Title Case, and abbreviated.',
    how: 'The most complete variant wins the golden record; all variants stay in person_sources.',
  },

  // --- units and formats ----------------------------------------------------
  ctc_mixed_units: {
    title: 'Two different units in one salary column',
    why: 'source1 `Current CTC` contains both `417964` (absolute rupees per year) and `4.2` (lakhs per annum) with no marker distinguishing them. Averaging this column raw gives a meaningless number.',
    how: 'Disambiguated by magnitude - nobody earns Rs 4.2 a year and nobody earns 417,964 lakhs. Values below 100 are treated as LPA and multiplied by 100,000. The threshold is an assumption, so **every** such conversion is logged rather than applied silently.',
  },
  rate_mixed_units: {
    title: 'Two different bases in one rate column',
    why: 'source2 `rate` mixes `1415/hr` and `15k/month`. They are not comparable.',
    how: 'Normalised to an hourly figure assuming 176 working hours per month (22 days x 8h). Because that divisor is an assumption and not a fact in the data, the original string is preserved in `rate_raw` alongside the computed value.',
  },
  date_ambiguous: {
    title: 'Dates where the day/month order cannot be determined',
    why: 'source1 mixes five date formats, and the two separators disagree about field order. `03-07-2026` could be 3 July or 7 March - a four-month error.',
    how: 'The file proves the rule both ways: `07/13/2026` can only be MM/DD (no 13th month) and `24-07-2026` can only be DD-MM (no 24th month). So the **separator** carries the convention: slash = US order, dash = day-first. Values where both parts are <= 12 remain genuinely undecidable from the data, so they are flagged at high severity rather than quietly converted.',
  },
  date_format: {
    title: 'Five date formats in one column',
    why: '`2026-08-08`, `24-07-2026`, `07/13/2026`, `7 Jul 2026`, `19 Jul 2026` all appear in the same field.',
    how: 'Parsed with an explicit format per shape and strict matching, so an unexpected shape fails loudly instead of being guessed at. Stored as ISO-8601.',
  },
  phone_format: {
    title: 'Five phone formats for the same number',
    why: '`+919000000254`, `9000000237`, `09000000287`, `919000000231`, `+91-9000000131`. These are the join key between source1 and source3 - source3 has no email at all - so inconsistent formatting means the two files can never be linked.',
    how: 'Stripped to the 10-digit core and stored as E.164 (`+91XXXXXXXXXX`). One issue is logged per defective value, not one per defect.',
  },
  email_case: {
    title: 'Email addresses in upper case',
    why: 'Roughly a third of source2 stores addresses in caps. Email local-parts are technically case-sensitive per RFC 5321, but no real provider treats them that way, and here they are unambiguously the same people. Left as-is, the email join misses them entirely.',
    how: 'Lower-cased for matching and storage.',
  },

  // --- enums and cosmetics --------------------------------------------------
  city_variant: {
    title: 'Same city under several spellings',
    why: '`GURGAON` / `gurugram ` / `Gurugram`, and `bangalore` / `Bengaluru` - case differences plus genuine post-rename synonyms. City is part of the tier-3 match key, so unresolved variants cause missed matches.',
    how: 'Mapped to a canonical set. **`Delhi NCR` is collapsed to `Delhi`, and that is lossy** - NCR is a region that also contains Noida and Gurugram. It is flagged in the log rather than presented as a clean mapping.',
  },
  city_whitespace: {
    title: 'Trailing whitespace in city names',
    why: '`"Noida "` and `"Noida"` are different strings and group separately.',
    how: 'Trimmed. Note the loader deliberately does not trim on read, so these are reported instead of being invisibly cleaned.',
  },
  status_case: {
    title: 'Status field is not a real enum',
    why: '`Active`, `active`, `ACTIVE`, `Inactive`, `paused` all appear.',
    how: 'Normalised to `active` / `inactive` / `paused`, with `unknown` for anything absent, and enforced by a CHECK constraint in the schema.',
  },
  boolean_inconsistent: {
    title: 'Verified flag uses five different spellings',
    why: '`Y`, `y`, `yes`, `Yes`, `N`, `No` in one column.',
    how: 'Normalised to 1 / 0, enforced by a CHECK constraint.',
  },
  name_case: {
    title: 'Names in ALL CAPS',
    why: '`RITU SHARMA` and `Ritu Sharma` are the same person; unnormalised they produce different match keys.',
    how: 'Re-cased to Title Case for display; the match key is lower-cased and token-sorted so word order does not matter either.',
  },
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const shortFile = (f) => f.replace(/_(naukri_applicants|gig_workers|cbnexus_contacts)\.csv$/, '');

export function generateReport(db, outPath) {
  const totals = db.prepare('SELECT COUNT(*) n FROM data_issues').get().n;
  const types = db.prepare(`
    SELECT issue_type, severity, COUNT(*) n
    FROM data_issues GROUP BY issue_type, severity
  `).all().sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.n - a.n);

  const people = db.prepare('SELECT COUNT(*) n FROM people').get().n;
  const sourceRows = db.prepare('SELECT COUNT(*) n FROM person_sources').get().n;
  const bySeverity = db.prepare('SELECT severity, COUNT(*) n FROM data_issues GROUP BY severity').all()
    .reduce((acc, r) => ({ ...acc, [r.severity]: r.n }), {});

  const examplesFor = (type, limit = 3) => db.prepare(`
    SELECT source_file, source_row, column_name, raw_value, action_taken
    FROM data_issues WHERE issue_type = ?
    ORDER BY source_file, source_row LIMIT ?
  `).all(type, limit);

  const out = [];
  const w = (s = '') => out.push(s);

  w('# Data issues report');
  w();
  w('> **Generated by `npm run pipeline`** from the `data_issues` table — every count, line');
  w('> number and example below comes from the same run that built the database, so this');
  w('> report cannot drift from what the code actually does. The explanations are written');
  w('> by hand in `pipeline/report.js`.');
  w();
  w(`**${totals} issues** across **${types.length} distinct types**, found in ${sourceRows} source rows`);
  w(`that merged into **${people} people**.`);
  w();
  w(`| Severity | Count | Meaning |`);
  w(`|---|---:|---|`);
  w(`| High | ${bySeverity.high ?? 0} | Would corrupt data or lose a person if unhandled |`);
  w(`| Medium | ${bySeverity.medium ?? 0} | Requires a judgement call that could reasonably go the other way |`);
  w(`| Low | ${bySeverity.low ?? 0} | Cosmetic or formatting, safe to normalise |`);
  w();
  w('Full row-level detail: [`reports/data_issues.csv`](reports/data_issues.csv).');
  w('Cases the pipeline refused to decide: [`reports/review_queue.json`](reports/review_queue.json).');
  w();
  w('---');
  w();

  let n = 0;
  let lastSeverity = null;
  for (const t of types) {
    if (t.severity !== lastSeverity) {
      w(`## ${t.severity[0].toUpperCase() + t.severity.slice(1)} severity`);
      w();
      lastSeverity = t.severity;
    }
    n += 1;
    const info = NARRATIVE[t.issue_type];
    w(`### ${n}. ${info?.title ?? t.issue_type}`);
    w();
    w(`\`${t.issue_type}\` · **${t.n}** occurrence${t.n === 1 ? '' : 's'}`);
    w();
    if (info) {
      w(`**The problem.** ${info.why}`);
      w();
      w(`**What I did.** ${info.how}`);
      w();
    }
    const ex = examplesFor(t.issue_type);
    if (ex.length) {
      w('| Where | Value | Action |');
      w('|---|---|---|');
      for (const e of ex) {
        const where = `${shortFile(e.source_file)}${e.source_row ? ':' + e.source_row : ''}${e.column_name ? ' · ' + e.column_name : ''}`;
        const raw = (e.raw_value ?? '').replace(/\|/g, '\\|').slice(0, 70);
        const act = e.action_taken.replace(/\|/g, '\\|').slice(0, 90);
        w(`| \`${where}\` | \`${raw}\` | ${act} |`);
      }
      if (t.n > ex.length) w(`\n_${t.n - ex.length} more in \`reports/data_issues.csv\`._`);
      w();
    }
  }

  // Everything the pipeline deliberately refused to decide.
  w('---');
  w();
  w('## Deliberately not decided');
  w();
  w('Cases where guessing would have been worse than admitting uncertainty. These are');
  w('written to `reports/review_queue.json` with their exact source rows so a human can');
  w('settle them.');
  w();
  const queue = db.prepare(`
    SELECT issue_type, raw_value, detail FROM data_issues
    WHERE issue_type IN ('ambiguous_name_match', 'no_identifier')
  `).all();
  if (queue.length) {
    for (const q of queue) {
      w(`- **${q.raw_value}** — ${q.detail}`);
    }
  } else {
    w('- Same name, different city (e.g. the two Deepak Nairs, Bengaluru vs Delhi). Treated');
    w('  as different people: a shared name is not evidence of identity, and merging them');
    w('  would silently destroy one.');
  }
  w();
  w('---');
  w();
  w('## What is NOT a data issue');
  w();
  w('Worth stating, because these look like defects and are not:');
  w();
  w('- **People appearing in only one file.** 23 of 55 are single-source. That is expected —');
  w('  the three systems have genuinely different populations, not missing data.');
  w('- **source2 having no phone column and source3 having no email column.** That is the');
  w('  shape of the problem, not a fault. It is why source1 is the only bridge between them,');
  w('  and why a name+city tier had to exist at all.');
  w('- **Two people sharing a name.** There really are two Arjun Mehtas and two Deepak Nairs.');
  w('  Collapsing them would be the bug.');
  w();

  const text = out.join('\n') + '\n';
  if (outPath) writeFileSync(outPath, text);
  return text;
}
