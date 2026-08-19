/**
 * Identity resolution, asserted end-to-end against the real three files.
 *
 * These are the cases the dataset was built to punish. Each test names the trap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSource, SOURCES } from '../pipeline/clean.js';
import { stageAll } from '../pipeline/stage.js';
import { matchRecords } from '../pipeline/match.js';
import { buildGoldenRecord } from '../pipeline/survivorship.js';

// Build the full merge once and reuse it across tests.
const rows = SOURCES.flatMap((s) => loadSource(s.path, s).rows);
const { records } = stageAll(rows);
const { clusters, issues, reviewQueue } = matchRecords(records);
const people = clusters.map((c) => buildGoldenRecord(c.indices.map((i) => records[i]), c));

const byName = (n) => people.filter((p) => p.person.full_name === n);
const emailsOf = (p) => p.identifiers.filter((i) => i.id_type === 'email').map((i) => i.value).sort();
const phonesOf = (p) => p.identifiers.filter((i) => i.id_type === 'phone').map((i) => i.value).sort();

test('every source row lands in exactly one person', () => {
  const seen = new Set();
  let total = 0;
  for (const p of people) {
    for (const s of p.sources) {
      const key = `${s.source_file}:${s.source_row}`;
      assert.ok(!seen.has(key), `${key} appears in two people`);
      seen.add(key);
      total += 1;
    }
  }
  assert.equal(total, records.length);
  assert.equal(total, 102);
});

// ---------------------------------------------------------------------------
// TRAP 1: two different people share a name AND a city.
// ---------------------------------------------------------------------------
test('the two Arjun Mehtas of Noida are NOT merged', () => {
  const arjuns = byName('Arjun Mehta');
  assert.ok(arjuns.length >= 2, `expected at least 2 Arjun Mehtas, got ${arjuns.length}`);

  // source1's Arjun Mehta is joined to source3 by phone - that one is real.
  const withPhone = arjuns.find((p) => p.person.primary_phone === '+919000000131');
  assert.ok(withPhone, 'source1+source3 Arjun Mehta did not merge on phone');
  assert.equal(withPhone.person.primary_email, 'arjun.mehta9@example.in');

  // The other source3 Arjun Mehta has a different phone and must stay separate.
  const other = arjuns.find((p) => p.person.primary_phone === '+919000000272');
  assert.ok(other, 'the second source3 Arjun Mehta disappeared');
  assert.notEqual(withPhone.person.primary_phone, other.person.primary_phone);

  // And the guard must have fired rather than silently doing nothing.
  assert.ok(issues.some((i) => i.issue_type === 'ambiguous_name_match' && /arjun mehta/.test(i.raw_value)),
    'ambiguous name+city was not reported');
});

test('the ambiguous case is queued for a human, not dropped on the floor', () => {
  assert.ok(reviewQueue.some((r) => r.reason === 'ambiguous_name_match' && /arjun mehta/.test(r.nameCity)));
});

// ---------------------------------------------------------------------------
// TRAP 2: one person holding two different email addresses.
// ---------------------------------------------------------------------------
test('Nikhil Chopra is ONE person despite two email addresses', () => {
  const nikhils = byName('Nikhil Chopra');
  assert.equal(nikhils.length, 1, `expected 1 Nikhil Chopra, got ${nikhils.length}`);

  const emails = emailsOf(nikhils[0]);
  assert.deepEqual(emails, ['alt.nikhil.chopra70@example.com', 'nikhil.chopra70@example.com']);
  // The alias must not become the primary.
  assert.equal(nikhils[0].person.primary_email, 'nikhil.chopra70@example.com');
  // Only the phone could have linked these - email matching alone would make two people.
  assert.ok(nikhils[0].person.match_reason.includes('tier2'));
});

// ---------------------------------------------------------------------------
// TRAP 3: same person, name abbreviated in one row.
// ---------------------------------------------------------------------------
test('"R. Verma" collapses into "Rohit Verma" and the fuller name wins', () => {
  assert.equal(byName('R. Verma').length, 0, 'the abbreviated name survived as its own person');
  const rohit = byName('Rohit Verma');
  assert.equal(rohit.length, 1);
  assert.equal(rohit[0].sources.length, 2, 'both source1 rows should be under one person');
  assert.ok(rohit[0].person.match_reason.includes('tier1'));
});

// ---------------------------------------------------------------------------
// TRAP 4: two different people share a name but not a city.
// ---------------------------------------------------------------------------
test('the two Deepak Nairs are NOT merged', () => {
  const nairs = byName('Deepak Nair');
  assert.equal(nairs.length, 2, `expected 2 Deepak Nairs, got ${nairs.length}`);
  const cities = nairs.map((p) => p.person.city).sort();
  assert.deepEqual(cities, ['Bengaluru', 'Delhi']);
});

// ---------------------------------------------------------------------------
// Tier 3: the only way source2 and source3 can meet without a source1 bridge.
// ---------------------------------------------------------------------------
test('tier-3 links the people who exist in source2 and source3 but not source1', () => {
  const medium = people.filter((p) => p.person.match_confidence === 'medium');
  const names = medium.map((p) => p.person.full_name).sort();
  assert.deepEqual(names, ['Divya Chopra', 'Karan Chopra', 'Manish Bhatia', 'Vikram Mehta']);

  for (const p of medium) {
    // Each must carry an email from source2 and a phone from source3.
    assert.ok(emailsOf(p).length >= 1, `${p.person.full_name} has no email`);
    assert.ok(phonesOf(p).length >= 1, `${p.person.full_name} has no phone`);
    assert.ok(p.person.match_reason.includes('tier3'));
    const files = new Set(p.sources.map((s) => s.source_file));
    assert.ok(files.has('source2_gig_workers.csv') && files.has('source3_cbnexus_contacts.csv'),
      `${p.person.full_name} is not a source2+source3 pair`);
  }
});

test('a tier-3 merge is labelled medium confidence, never high', () => {
  for (const p of people) {
    if (p.person.match_reason.includes('tier3') && !p.person.match_reason.includes('tier1') && !p.person.match_reason.includes('tier2')) {
      assert.equal(p.person.match_confidence, 'medium');
    }
  }
});

// ---------------------------------------------------------------------------
// Survivorship
// ---------------------------------------------------------------------------
test('field ownership: each source wins the fields it actually manages', () => {
  // Varun Jain appears in all three files.
  const v = byName('Varun Jain');
  assert.equal(v.length, 1);
  const p = v[0].person;
  assert.equal(p.experience_years, 3.1);            // source1 owns experience
  assert.equal(p.current_ctc_inr, 760000);          // source1, 7.6 LPA
  assert.equal(p.gig_status, 'active');             // source2 owns status
  assert.equal(p.rate_raw, '1415/hr');              // source2 owns rate
  assert.equal(p.is_verified, 1);                   // source3 owns verified
  assert.equal(p.projects_completed, 14);           // source3 owns projects
});

test('city disagreements are resolved and logged, not dropped', () => {
  // Meera Bhatia: source1 'Delhi NCR', source2 'New Delhi', source3 'Delhi' -> all map to Delhi.
  const m = byName('Meera Bhatia');
  assert.equal(m.length, 1);
  assert.equal(m[0].person.city, 'Delhi');
});

test('skills are unioned across sources, not taken from one', () => {
  const v = byName('Varun Jain')[0];
  const names = v.skills.map((s) => s.canonical_name).sort();
  assert.deepEqual(names, ['FastAPI', 'MongoDB', 'MySQL', 'Pandas', 'Web Scraping', 'n8n']);
});

test('confidence is never claimed higher than the evidence supports', () => {
  for (const p of people) {
    if (p.sources.length === 1) {
      assert.equal(p.person.match_confidence, 'single-source', `${p.person.full_name} over-claims confidence`);
    }
  }
});

test('no person is created without at least one identifier or a name', () => {
  for (const p of people) {
    assert.ok(p.person.full_name, 'person with no name');
    assert.ok(p.identifiers.length > 0 || p.sources.length > 0);
  }
});
