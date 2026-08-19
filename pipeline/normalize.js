/**
 * Field-level normalisers.
 *
 * Every function here is pure and returns { value, issues } where `issues` is a
 * list of data-quality problems found while normalising. The caller collects
 * them into the `data_issues` table, which is what DATA_ISSUES.md (Task 4) is
 * generated from. Nothing is silently "fixed" - if we make an assumption, we log it.
 */

import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

/** Helper: build one issue record. */
const issue = (type, severity, rawValue, action, detail) => ({
  issue_type: type,
  severity,
  raw_value: rawValue === undefined || rawValue === null ? null : String(rawValue),
  action_taken: action,
  detail: detail ?? null,
});

const ok = (value) => ({ value, issues: [] });

/** True for '', '   ', null, undefined. */
export const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * Source data carries five different shapes for the same number:
 *   +919000000254 | 9000000237 | 09000000287 | 919000000231 | +91-9000000131
 *
 * All of them reduce to the same 10 digits. That 10-digit core is the join key
 * between source1 and source3 - source3 has no email at all, so without this
 * they can never be linked.
 */
export function normalizePhone(raw, ctx = {}) {
  if (isBlank(raw)) return ok(null);

  const original = String(raw).trim();
  const issues = [];
  let digits = original.replace(/\D/g, '');
  const hadSeparators = original !== original.replace(/[\s\-()]/g, '');

  // Strip country code / trunk prefix, longest first.
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  } else if (digits.length === 13 && digits.startsWith('091')) {
    digits = digits.slice(3);
  }

  if (digits.length !== 10) {
    issues.push(issue('phone_invalid', 'high', original,
      'Kept raw value, excluded from phone matching',
      `Reduced to ${digits.length} digits, expected 10`));
    return { value: null, issues };
  }

  // Indian mobile numbers start 6-9. Anything else is suspicious but we keep it.
  if (!/^[6-9]/.test(digits)) {
    issues.push(issue('phone_suspicious', 'medium', original,
      'Kept and used for matching',
      `Starts with ${digits[0]}; Indian mobile numbers start 6-9`));
  }

  // One issue per defective value, not one per defect. A number like
  // '+91-9000000131' has both a separator and a non-canonical prefix, but that
  // is one problem with one row, and logging it twice inflates the report.
  if (original !== `+91${digits}`) {
    issues.push(issue('phone_format', 'low', original,
      `Normalised to +91${digits}`,
      hadSeparators
        ? 'Contained separators and a non-canonical prefix; phone formats are inconsistent across sources'
        : (ctx.note ?? 'Inconsistent phone format across sources')));
  }

  return { value: `+91${digits}`, issues, last10: digits };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * source2 stores roughly half its emails in UPPER CASE. Email local-parts are
 * technically case-sensitive per RFC 5321, but no real mail provider treats them
 * that way - and here they are unambiguously the same people. Lower-casing is
 * required or the email join silently misses half of source2.
 */
export function normalizeEmail(raw) {
  if (isBlank(raw)) return ok(null);

  const original = String(raw).trim();
  const issues = [];
  const lowered = original.toLowerCase();

  if (original !== lowered) {
    issues.push(issue('email_case', 'medium', original,
      `Lower-cased to ${lowered}`,
      'Mixed-case email would not match the same address written in lower case'));
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lowered)) {
    issues.push(issue('email_invalid', 'high', original,
      'Kept raw value, excluded from email matching', 'Failed basic shape check'));
    return { value: null, issues };
  }

  return { value: lowered, issues };
}

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

/**
 * Returns both a display form and a match key.
 *   'RITU SHARMA'  -> display 'Ritu Sharma', key 'ritu sharma'
 *   'R. Verma'     -> display 'R. Verma',    key 'verma'   (initial dropped)
 *
 * Dropping single-letter tokens from the key matters: 'R. Verma' must not be
 * allowed to fuzzy-match every Verma in the file. It is deliberately a weak key,
 * and matching treats it as such.
 */
export function normalizeName(raw) {
  if (isBlank(raw)) return { value: null, key: null, issues: [] };

  const original = String(raw);
  const issues = [];
  const collapsed = original.trim().replace(/\s+/g, ' ');

  if (original !== collapsed) {
    issues.push(issue('name_whitespace', 'low', original,
      `Trimmed to "${collapsed}"`, 'Leading/trailing or repeated whitespace'));
  }

  const isAllCaps = collapsed === collapsed.toUpperCase() && /[A-Z]{2}/.test(collapsed);
  const display = collapsed
    .split(' ')
    .map((tok) => (tok.length ? tok[0].toUpperCase() + tok.slice(1).toLowerCase() : tok))
    .join(' ');

  if (isAllCaps) {
    issues.push(issue('name_case', 'low', original,
      `Re-cased to "${display}"`, 'Stored in ALL CAPS in this source'));
  }

  const tokens = display.toLowerCase().replace(/[.]/g, '').split(' ').filter(Boolean);
  const full = tokens.filter((t) => t.length > 1);
  const hasInitial = tokens.length !== full.length;

  if (hasInitial) {
    issues.push(issue('name_abbreviated', 'medium', original,
      'Excluded initials from the match key',
      'Abbreviated given name cannot safely drive a name-based match'));
  }

  // Sorted so 'Verma Rohit' and 'Rohit Verma' produce the same key.
  const key = full.slice().sort().join(' ') || null;

  return { value: display, key, issues, hasInitial };
}

// ---------------------------------------------------------------------------
// City
// ---------------------------------------------------------------------------

/**
 * Same city, eight spellings: 'GURGAON', 'gurugram ', 'Gurugram'.
 * Plus genuine synonyms after the 2014/2016 renamings.
 */
const CITY_CANON = new Map(Object.entries({
  'gurgaon': 'Gurugram',
  'gurugram': 'Gurugram',
  'bangalore': 'Bengaluru',
  'bengaluru': 'Bengaluru',
  'delhi': 'Delhi',
  'new delhi': 'Delhi',
  'delhi ncr': 'Delhi',
  'noida': 'Noida',
  'pune': 'Pune',
}));

export function normalizeCity(raw) {
  if (isBlank(raw)) return ok(null);

  const original = String(raw);
  const issues = [];
  const cleaned = original.trim().replace(/\s+/g, ' ').toLowerCase();

  if (original !== original.trim()) {
    issues.push(issue('city_whitespace', 'low', original,
      `Trimmed to "${original.trim()}"`, 'Trailing whitespace would break grouping'));
  }

  const canon = CITY_CANON.get(cleaned);

  if (!canon) {
    issues.push(issue('city_unknown', 'medium', original,
      'Kept as Title Case, not mapped to a canonical city',
      'Not in the canonical city list; excluded from city-based matching'));
    const titled = cleaned.split(' ').map((t) => t[0].toUpperCase() + t.slice(1)).join(' ');
    return { value: titled, issues, canonical: false };
  }

  if (cleaned !== canon.toLowerCase()) {
    issues.push(issue('city_variant', 'low', original,
      `Mapped to "${canon}"`,
      cleaned === 'delhi ncr'
        ? 'Delhi NCR is a region, not a city - it also contains Noida and Gurugram, so this collapse loses information'
        : 'Case variant or renamed-city synonym'));
  }

  return { value: canon, issues, canonical: true };
}

// ---------------------------------------------------------------------------
// Applied date
// ---------------------------------------------------------------------------

/**
 * source1 uses five formats in one column:
 *   2026-08-08 | 24-07-2026 | 07/13/2026 | 7 Jul 2026 | 19 Jul 2026
 *
 * The two separators disagree about field order, and the file proves it both ways:
 *   '07/13/2026' can only be MM/DD  (no 13th month)
 *   '24-07-2026' can only be DD-MM  (no 24th month)
 * So: slash => US order, dash => day-first. Values where both parts are <= 12
 * are genuinely undecidable from the data; we apply the separator rule and log
 * them rather than guessing silently.
 */
export function parseAppliedDate(raw) {
  if (isBlank(raw)) return ok(null);

  const original = String(raw).trim();
  const issues = [];

  let parsed = null;
  let assumedFormat = null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(original)) {
    parsed = dayjs(original, 'YYYY-MM-DD', true);
    assumedFormat = 'YYYY-MM-DD';
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(original)) {
    parsed = dayjs(original, 'MM/DD/YYYY', true);
    assumedFormat = 'MM/DD/YYYY';
    const [a, b] = original.split('/').map(Number);
    if (a <= 12 && b <= 12) {
      issues.push(issue('date_ambiguous', 'high', original,
        `Read as MM/DD/YYYY -> ${parsed.format('YYYY-MM-DD')}`,
        'Both parts <= 12. Slash format resolved as US order because 07/13/2026 exists in this file and can only be MM/DD'));
    }
  } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(original)) {
    parsed = dayjs(original, 'DD-MM-YYYY', true);
    assumedFormat = 'DD-MM-YYYY';
    const [a, b] = original.split('-').map(Number);
    if (a <= 12 && b <= 12) {
      issues.push(issue('date_ambiguous', 'high', original,
        `Read as DD-MM-YYYY -> ${parsed.format('YYYY-MM-DD')}`,
        'Both parts <= 12. Dash format resolved as day-first because 24-07-2026 exists in this file and can only be DD-MM'));
    }
  } else if (/^\d{1,2} [A-Za-z]{3} \d{4}$/.test(original)) {
    parsed = dayjs(original, 'D MMM YYYY', true);
    assumedFormat = 'D MMM YYYY';
  }

  if (!parsed || !parsed.isValid()) {
    issues.push(issue('date_unparseable', 'high', original, 'Stored as NULL', 'No known format matched'));
    return { value: null, issues };
  }

  if (assumedFormat !== 'YYYY-MM-DD') {
    issues.push(issue('date_format', 'low', original,
      `Parsed as ${assumedFormat} -> ${parsed.format('YYYY-MM-DD')}`,
      'Column mixes five date formats'));
  }

  return { value: parsed.format('YYYY-MM-DD'), issues, assumedFormat };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Below this, a CTC figure has to be lakhs-per-annum rather than rupees. */
const LPA_THRESHOLD = 100;

/**
 * source1 'Current CTC' mixes two units in one column with no marker:
 *   417964  -> absolute rupees per year
 *   4.2     -> lakhs per year (= 420000)
 * Nobody earns Rs 4.2/year and nobody earns 417964 lakhs, so the magnitude
 * disambiguates. The threshold is the assumption, so it is logged every time.
 */
export function parseCtc(raw) {
  if (isBlank(raw)) return ok(null);

  const original = String(raw).trim();
  const issues = [];
  const num = Number(original.replace(/[,\s₹]/g, ''));

  if (!Number.isFinite(num)) {
    issues.push(issue('ctc_unparseable', 'high', original, 'Stored as NULL', 'Not numeric'));
    return { value: null, issues };
  }

  if (num < LPA_THRESHOLD) {
    const inr = Math.round(num * 100000);
    issues.push(issue('ctc_mixed_units', 'high', original,
      `Interpreted as ${num} LPA -> ${inr} INR/year`,
      `Column mixes absolute INR and lakhs-per-annum. Values below ${LPA_THRESHOLD} treated as LPA`));
    return { value: inr, issues, unit: 'lpa' };
  }

  return { value: Math.round(num), issues, unit: 'inr' };
}

/** Assumed working month: 22 days x 8 hours. Stated so the conversion is auditable. */
export const HOURS_PER_MONTH = 176;

/**
 * source2 'rate' mixes two bases: '1415/hr' and '15k/month'.
 * We store the normalised hourly figure AND the original string, because the
 * hours-per-month divisor is an assumption we are making, not a fact in the data.
 */
export function parseRate(raw) {
  if (isBlank(raw)) return ok(null);

  const original = String(raw).trim();
  const issues = [];
  const m = original.match(/^([\d.]+)\s*(k?)\s*\/\s*(hr|hour|month|mo)$/i);

  if (!m) {
    issues.push(issue('rate_unparseable', 'high', original, 'Stored as NULL, raw kept in rate_raw', 'Unrecognised rate format'));
    return { value: null, issues, raw: original };
  }

  const [, numStr, kFlag, basisRaw] = m;
  let amount = Number(numStr);
  if (kFlag.toLowerCase() === 'k') amount *= 1000;

  const basis = /^(hr|hour)$/i.test(basisRaw) ? 'hour' : 'month';

  if (basis === 'hour') {
    return { value: amount, issues, basis, raw: original };
  }

  const perHour = Number((amount / HOURS_PER_MONTH).toFixed(2));
  issues.push(issue('rate_mixed_units', 'medium', original,
    `Converted ${amount} INR/month -> ${perHour} INR/hour`,
    `Column mixes /hr and k/month. Assumed ${HOURS_PER_MONTH} working hours per month (22 days x 8h)`));

  return { value: perHour, issues, basis, raw: original };
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** 'Active' | 'active' | 'ACTIVE' | 'Inactive' | 'paused' -> a real enum. */
export function normalizeStatus(raw) {
  if (isBlank(raw)) return { value: 'unknown', issues: [] };

  const original = String(raw).trim();
  const issues = [];
  const lowered = original.toLowerCase();

  if (!['active', 'inactive', 'paused'].includes(lowered)) {
    issues.push(issue('status_unknown', 'medium', original,
      "Stored as 'unknown'", 'Not one of active/inactive/paused'));
    return { value: 'unknown', issues };
  }

  if (original !== lowered) {
    issues.push(issue('status_case', 'low', original,
      `Lower-cased to "${lowered}"`, 'Status column is not case-consistent'));
  }

  return { value: lowered, issues };
}

/** 'Y' | 'yes' | 'Yes' | 'N' | 'No' -> 1 / 0. */
export function parseVerified(raw) {
  if (isBlank(raw)) return ok(null);

  const original = String(raw).trim();
  const issues = [];
  const lowered = original.toLowerCase();

  const truthy = ['y', 'yes', 'true', '1'];
  const falsy = ['n', 'no', 'false', '0'];

  if (!truthy.includes(lowered) && !falsy.includes(lowered)) {
    issues.push(issue('verified_unparseable', 'medium', original, 'Stored as NULL', 'Not a recognised boolean'));
    return { value: null, issues };
  }

  const value = truthy.includes(lowered) ? 1 : 0;
  issues.push(issue('boolean_inconsistent', 'low', original,
    `Normalised to ${value}`, 'Column uses Y/N/yes/Yes/No interchangeably'));

  return { value, issues };
}

export function parseInteger(raw, columnName) {
  if (isBlank(raw)) return ok(null);
  const original = String(raw).trim();
  const num = Number(original);
  if (!Number.isInteger(num)) {
    return { value: null, issues: [issue('integer_unparseable', 'medium', original, 'Stored as NULL', `${columnName} was not an integer`)] };
  }
  return ok(num);
}

export function parseFloatField(raw, columnName) {
  if (isBlank(raw)) return ok(null);
  const original = String(raw).trim();
  const num = Number(original);
  if (!Number.isFinite(num)) {
    return { value: null, issues: [issue('float_unparseable', 'medium', original, 'Stored as NULL', `${columnName} was not numeric`)] };
  }
  return ok(num);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** source1 writes 'REST APIs', source2 writes 'rest apis'. Same skill. */
const SKILL_DISPLAY = new Map(Object.entries({
  'n8n': 'n8n',
  'langchain': 'LangChain',
  'rest apis': 'REST APIs',
  'mongodb': 'MongoDB',
  'mysql': 'MySQL',
  'sql': 'SQL',
  'fastapi': 'FastAPI',
  'web scraping': 'Web Scraping',
  'javascript': 'JavaScript',
  'react': 'React',
  'docker': 'Docker',
  'zapier': 'Zapier',
  'python': 'Python',
  'pandas': 'Pandas',
  'selenium': 'Selenium',
}));

export function normalizeSkills(raw) {
  if (isBlank(raw)) return { value: [], issues: [] };

  const original = String(raw);
  const issues = [];
  const seen = new Set();
  const out = [];

  for (const part of original.split(',')) {
    const key = part.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      issues.push(issue('skill_duplicate', 'low', part.trim(), 'Dropped duplicate', 'Skill listed twice in the same cell'));
      continue;
    }
    seen.add(key);

    const display = SKILL_DISPLAY.get(key);
    if (!display) {
      issues.push(issue('skill_unknown', 'low', part.trim(),
        'Kept as-is', 'Not in the canonical skill list'));
      out.push({ canonical_name: part.trim(), match_key: key });
      continue;
    }
    out.push({ canonical_name: display, match_key: key });
  }

  return { value: out, issues };
}
