/**
 * Every input string in this file is copied verbatim out of the three source CSVs.
 * If a normaliser regresses, these fail with the real data, not with invented data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePhone, normalizeEmail, normalizeName, normalizeCity,
  parseAppliedDate, parseCtc, parseRate, normalizeStatus,
  parseVerified, normalizeSkills, HOURS_PER_MONTH,
} from '../pipeline/normalize.js';

test('phone: all five source formats collapse to one E.164 value', () => {
  const variants = [
    '+919000000254', '9000000254', '09000000254', '919000000254', '+91-9000000254',
  ];
  for (const v of variants) {
    assert.equal(normalizePhone(v).value, '+919000000254', `failed on ${v}`);
  }
});

test('phone: this is what links source1 to source3', () => {
  // source1 'Arjun Mishra' vs source3 'Arjun Mishra' - different strings, same human.
  assert.equal(normalizePhone('9000000106').value, normalizePhone('919000000106').value);
  // source1 'Priya Saxena' vs source3 'Priya Saxena'
  assert.equal(normalizePhone('+919000000231').value, normalizePhone('919000000231').value);
});

test('phone: garbage is rejected rather than half-matched', () => {
  const r = normalizePhone('12345');
  assert.equal(r.value, null);
  assert.equal(r.issues[0].issue_type, 'phone_invalid');
});

test('email: source2 upper-case addresses must match source1 lower-case', () => {
  assert.equal(
    normalizeEmail('ISHA.CHOPRA95@MAILTEST.EXAMPLE.ORG').value,
    normalizeEmail('isha.chopra95@mailtest.example.org').value,
  );
  assert.equal(normalizeEmail('ISHA.CHOPRA95@MAILTEST.EXAMPLE.ORG').issues[0].issue_type, 'email_case');
});

test('name: ALL CAPS and Title Case produce the same match key', () => {
  assert.equal(normalizeName('RITU SHARMA').key, normalizeName('Ritu Sharma').key);
  assert.equal(normalizeName('RITU SHARMA').value, 'Ritu Sharma');
  assert.equal(normalizeName('MEERA BHATIA').value, 'Meera Bhatia');
});

test('name: an initial is dropped from the key and flagged', () => {
  const r = normalizeName('R. Verma');
  assert.equal(r.key, 'verma');
  assert.equal(r.hasInitial, true);
  assert.ok(r.issues.some((i) => i.issue_type === 'name_abbreviated'));
});

test('city: case, trailing space and renamed-city synonyms all converge', () => {
  for (const v of ['GURGAON', 'gurugram ', 'Gurugram', 'gurgaon']) {
    assert.equal(normalizeCity(v).value, 'Gurugram', `failed on "${v}"`);
  }
  for (const v of ['bangalore', 'Bangalore', 'Bengaluru']) {
    assert.equal(normalizeCity(v).value, 'Bengaluru', `failed on "${v}"`);
  }
  for (const v of ['Delhi', 'new delhi', 'New Delhi', 'Delhi NCR']) {
    assert.equal(normalizeCity(v).value, 'Delhi', `failed on "${v}"`);
  }
  for (const v of ['NOIDA', 'Noida ', 'Noida']) {
    assert.equal(normalizeCity(v).value, 'Noida', `failed on "${v}"`);
  }
});

test('city: collapsing Delhi NCR is lossy and says so', () => {
  const r = normalizeCity('Delhi NCR');
  assert.ok(r.issues.some((i) => i.detail?.includes('region, not a city')));
});

test('date: all five source1 formats parse to ISO', () => {
  assert.equal(parseAppliedDate('2026-08-08').value, '2026-08-08'); // ISO
  assert.equal(parseAppliedDate('24-07-2026').value, '2026-07-24'); // DD-MM, unambiguous
  assert.equal(parseAppliedDate('07/13/2026').value, '2026-07-13'); // MM/DD, unambiguous
  assert.equal(parseAppliedDate('7 Jul 2026').value, '2026-07-07');
  assert.equal(parseAppliedDate('19 Jul 2026').value, '2026-07-19');
});

test('date: the two separators disagree about field order, and both are proven by the file', () => {
  // Same digits, different separator => deliberately different dates.
  // The separator rule makes each pair swap, which is the whole point:
  assert.equal(parseAppliedDate('07-03-2026').value, '2026-03-07'); // dash  => DD-MM => 7 March
  assert.equal(parseAppliedDate('07/03/2026').value, '2026-07-03'); // slash => MM/DD => 3 July

  assert.equal(parseAppliedDate('03-07-2026').value, '2026-07-03'); // dash  => DD-MM => 3 July
  assert.equal(parseAppliedDate('03/07/2026').value, '2026-03-07'); // slash => MM/DD => 7 March

  // Both of these strings really are in source1, four months apart in meaning.
  assert.notEqual(parseAppliedDate('07-03-2026').value, parseAppliedDate('07/03/2026').value);
});

test('date: ambiguous values are flagged high severity, not silently guessed', () => {
  const r = parseAppliedDate('07/03/2026');
  assert.ok(r.issues.some((i) => i.issue_type === 'date_ambiguous' && i.severity === 'high'));
  // Unambiguous ones are not flagged as ambiguous.
  assert.ok(!parseAppliedDate('07/13/2026').issues.some((i) => i.issue_type === 'date_ambiguous'));
});

test('ctc: one column, two units, disambiguated by magnitude', () => {
  assert.equal(parseCtc('417964').value, 417964);   // absolute INR
  assert.equal(parseCtc('4.2').value, 420000);      // lakhs per annum
  assert.equal(parseCtc('11.9').value, 1190000);
  assert.equal(parseCtc('1195422').value, 1195422);
});

test('ctc: the LPA assumption is always logged', () => {
  assert.ok(parseCtc('4.2').issues.some((i) => i.issue_type === 'ctc_mixed_units'));
  assert.ok(!parseCtc('417964').issues.some((i) => i.issue_type === 'ctc_mixed_units'));
});

test('rate: /hr and k/month reduce to a common hourly basis', () => {
  assert.equal(parseRate('1415/hr').value, 1415);
  assert.equal(parseRate('15k/month').value, Number((15000 / HOURS_PER_MONTH).toFixed(2)));
  assert.equal(parseRate('72k/month').basis, 'month');
  assert.equal(parseRate('403/hr').basis, 'hour');
});

test('rate: the original string survives, because the divisor is an assumption', () => {
  assert.equal(parseRate('15k/month').raw, '15k/month');
});

test('status: five spellings, three states', () => {
  assert.equal(normalizeStatus('Active').value, 'active');
  assert.equal(normalizeStatus('ACTIVE').value, 'active');
  assert.equal(normalizeStatus('active').value, 'active');
  assert.equal(normalizeStatus('Inactive').value, 'inactive');
  assert.equal(normalizeStatus('paused').value, 'paused');
  assert.equal(normalizeStatus('').value, 'unknown');
});

test('verified: Y/yes/Yes/N/No become 1/0', () => {
  for (const v of ['Y', 'y', 'yes', 'Yes', 'YES']) assert.equal(parseVerified(v).value, 1, `failed on ${v}`);
  for (const v of ['N', 'n', 'No', 'no']) assert.equal(parseVerified(v).value, 0, `failed on ${v}`);
});

test('skills: source1 Title Case and source2 lower case are the same skills', () => {
  const s1 = normalizeSkills('n8n, LangChain, REST APIs, MongoDB, SQL').value.map((s) => s.canonical_name);
  const s2 = normalizeSkills('n8n, langchain, rest apis, mongodb, sql').value.map((s) => s.canonical_name);
  assert.deepEqual(s1, s2);
  assert.deepEqual(s1, ['n8n', 'LangChain', 'REST APIs', 'MongoDB', 'SQL']);
});

test('blank input never throws', () => {
  for (const fn of [normalizePhone, normalizeEmail, normalizeCity, parseAppliedDate, parseCtc, parseRate, parseVerified]) {
    assert.doesNotThrow(() => fn(''));
    assert.doesNotThrow(() => fn(null));
    assert.doesNotThrow(() => fn(undefined));
  }
  assert.equal(normalizeName('  ').value, null);
  assert.deepEqual(normalizeSkills('').value, []);
});
