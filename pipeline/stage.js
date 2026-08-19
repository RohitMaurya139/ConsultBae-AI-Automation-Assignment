/**
 * Staging - turn a structurally-clean row from any of the three files into one
 * common shape, applying the field normalisers on the way.
 *
 * The three sources have nothing in common at the column level:
 *   source1: name, email, phone, city, experience, ctc, applied date, skills
 *   source2: email, name, rate, location, status, skills        <- no phone
 *   source3: name, phone, city, verified, projects completed    <- no email
 *
 * After staging they all look the same, which is what lets one matcher run
 * across all 102 rows.
 */

import {
  normalizePhone, normalizeEmail, normalizeName, normalizeCity,
  parseAppliedDate, parseCtc, parseRate, normalizeStatus,
  parseVerified, normalizeSkills, parseFloatField, parseInteger,
} from './normalize.js';

/** Attach source/row/column provenance to each issue a normaliser produced. */
function collect(target, result, { sourceFile, sourceRow, column }) {
  for (const i of result.issues ?? []) {
    target.push({ ...i, source_file: sourceFile, source_row: sourceRow, column_name: i.column_name ?? column });
  }
  return result;
}

const base = (row) => ({
  sourceFile: row.sourceFile,
  sourceRow: row.sourceRow,
  raw: row.data,
  name: null, nameKey: null, hasInitial: false,
  email: null, phone: null,
  city: null, cityCanonical: false,
  experienceYears: null, ctcInr: null, appliedDate: null,
  ratePerHour: null, rateRaw: null, status: null,
  isVerified: null, projectsCompleted: null,
  skills: [],
});

// ---------------------------------------------------------------------------

function stageSource1(row, issues) {
  const ctx = { sourceFile: row.sourceFile, sourceRow: row.sourceRow };
  const d = row.data;
  const rec = base(row);

  const name = collect(issues, normalizeName(d['Full Name']), { ...ctx, column: 'Full Name' });
  rec.name = name.value; rec.nameKey = name.key; rec.hasInitial = !!name.hasInitial;

  rec.email = collect(issues, normalizeEmail(d['Email']), { ...ctx, column: 'Email' }).value;
  rec.phone = collect(issues, normalizePhone(d['Phone']), { ...ctx, column: 'Phone' }).value;

  const city = collect(issues, normalizeCity(d['City']), { ...ctx, column: 'City' });
  rec.city = city.value; rec.cityCanonical = !!city.canonical;

  rec.experienceYears = collect(issues, parseFloatField(d['Experience (Years)'], 'Experience (Years)'), { ...ctx, column: 'Experience (Years)' }).value;
  rec.ctcInr = collect(issues, parseCtc(d['Current CTC']), { ...ctx, column: 'Current CTC' }).value;
  rec.appliedDate = collect(issues, parseAppliedDate(d['Applied Date']), { ...ctx, column: 'Applied Date' }).value;
  rec.skills = collect(issues, normalizeSkills(d['Skills']), { ...ctx, column: 'Skills' }).value;

  return rec;
}

function stageSource2(row, issues) {
  const ctx = { sourceFile: row.sourceFile, sourceRow: row.sourceRow };
  const d = row.data;
  const rec = base(row);

  const name = collect(issues, normalizeName(d['worker_name']), { ...ctx, column: 'worker_name' });
  rec.name = name.value; rec.nameKey = name.key; rec.hasInitial = !!name.hasInitial;

  rec.email = collect(issues, normalizeEmail(d['email_id']), { ...ctx, column: 'email_id' }).value;
  // source2 has no phone column at all - it can only reach source3 through source1.

  const city = collect(issues, normalizeCity(d['location']), { ...ctx, column: 'location' });
  rec.city = city.value; rec.cityCanonical = !!city.canonical;

  const rate = collect(issues, parseRate(d['rate']), { ...ctx, column: 'rate' });
  rec.ratePerHour = rate.value; rec.rateRaw = rate.raw ?? (d['rate'] ?? null);

  rec.status = collect(issues, normalizeStatus(d['status']), { ...ctx, column: 'status' }).value;
  rec.skills = collect(issues, normalizeSkills(d['skill_tags']), { ...ctx, column: 'skill_tags' }).value;

  return rec;
}

function stageSource3(row, issues) {
  const ctx = { sourceFile: row.sourceFile, sourceRow: row.sourceRow };
  const d = row.data;
  const rec = base(row);

  const name = collect(issues, normalizeName(d['Name']), { ...ctx, column: 'Name' });
  rec.name = name.value; rec.nameKey = name.key; rec.hasInitial = !!name.hasInitial;

  // source3 has no email column at all - it can only reach source2 through source1.
  rec.phone = collect(issues, normalizePhone(d['Phone Number']), { ...ctx, column: 'Phone Number' }).value;

  const city = collect(issues, normalizeCity(d['City']), { ...ctx, column: 'City' });
  rec.city = city.value; rec.cityCanonical = !!city.canonical;

  rec.isVerified = collect(issues, parseVerified(d['Verified']), { ...ctx, column: 'Verified' }).value;
  rec.projectsCompleted = collect(issues, parseInteger(d['Projects Completed'], 'Projects Completed'), { ...ctx, column: 'Projects Completed' }).value;

  return rec;
}

const STAGERS = {
  'source1_naukri_applicants.csv': stageSource1,
  'source2_gig_workers.csv': stageSource2,
  'source3_cbnexus_contacts.csv': stageSource3,
};

/**
 * @param {Array} rows  cleaned rows from clean.js, any mix of sources
 * @returns {{records: Array, issues: Array}}
 */
export function stageAll(rows) {
  const issues = [];
  const records = rows.map((row) => {
    const stager = STAGERS[row.sourceFile];
    if (!stager) throw new Error(`No stager registered for ${row.sourceFile}`);
    return stager(row, issues);
  });

  // A record with neither an email nor a phone can never be matched to anything.
  records.forEach((r) => {
    if (!r.email && !r.phone) {
      issues.push({
        issue_type: 'no_identifier',
        severity: 'high',
        raw_value: r.name,
        action_taken: 'Kept as a standalone person, cannot be matched to other sources',
        detail: 'Row has neither a usable email nor a usable phone number',
        source_file: r.sourceFile,
        source_row: r.sourceRow,
        column_name: null,
      });
    }
  });

  return { records, issues };
}
