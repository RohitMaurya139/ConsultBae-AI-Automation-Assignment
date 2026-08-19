/**
 * Survivorship - collapse a matched cluster of source rows into one golden record.
 *
 * The rule is ownership, not recency: each system is authoritative for the fields
 * it actually manages.
 *
 *   source1 (Naukri ATS)  owns  experience, CTC, applied date
 *   source2 (gig system)  owns  rate, status
 *   source3 (CBNexus)     owns  verified flag, projects completed
 *   name / city           contested - resolved by vote, then by source priority
 *
 * Every disagreement between sources is written to data_issues as a
 * `field_conflict`, so "which value won and why" is answerable from the database.
 */

const SOURCE_PRIORITY = [
  'source1_naukri_applicants.csv',   // richest record, and the only bridge file
  'source3_cbnexus_contacts.csv',    // internal system, human-verified
  'source2_gig_workers.csv',
];

const priorityOf = (f) => {
  const i = SOURCE_PRIORITY.indexOf(f);
  return i === -1 ? SOURCE_PRIORITY.length : i;
};

const from = (recs, file) => recs.filter((r) => r.sourceFile === file);
const label = (r) => `${r.sourceFile}:${r.sourceRow}`;

/** First non-null value of `field`, preferring the named source, then priority order. */
function pick(recs, field, preferredFile) {
  const ordered = [...recs].sort((a, b) => {
    if (preferredFile) {
      const ap = a.sourceFile === preferredFile ? -1 : 0;
      const bp = b.sourceFile === preferredFile ? -1 : 0;
      if (ap !== bp) return ap - bp;
    }
    return priorityOf(a.sourceFile) - priorityOf(b.sourceFile);
  });
  for (const r of ordered) {
    if (r[field] !== null && r[field] !== undefined && r[field] !== '') return { value: r[field], record: r };
  }
  return { value: null, record: null };
}

/** Log a conflict when a field carries more than one distinct non-null value. */
function noteConflict(issues, recs, field, column, chosen) {
  const seen = new Map();
  for (const r of recs) {
    const v = r[field];
    if (v === null || v === undefined || v === '') continue;
    if (!seen.has(v)) seen.set(v, []);
    seen.get(v).push(label(r));
  }
  if (seen.size < 2) return;

  const rendered = [...seen.entries()].map(([v, where]) => `${v} (${where.join(', ')})`).join(' vs ');
  issues.push({
    issue_type: 'field_conflict',
    severity: 'medium',
    raw_value: rendered,
    action_taken: `Kept "${chosen}"`,
    detail: `Sources disagree on ${column}. Resolved by source-ownership rule, losing values preserved in person_sources.`,
    source_file: recs[0].sourceFile,
    source_row: recs[0].sourceRow,
    column_name: column,
  });
}

/**
 * The best display form of a person's name across the cluster.
 * Prefers the most complete variant: most full-length tokens, then longest.
 * This is what turns the 'R. Verma' / 'Rohit Verma' pair into 'Rohit Verma'.
 */
function bestName(recs, issues) {
  const named = recs.filter((r) => r.name);
  if (!named.length) return null;

  const score = (r) => {
    const toks = r.name.split(' ');
    const full = toks.filter((t) => t.replace('.', '').length > 1).length;
    return [full, r.name.length, -priorityOf(r.sourceFile)];
  };

  const sorted = [...named].sort((a, b) => {
    const [af, al, ap] = score(a);
    const [bf, bl, bp] = score(b);
    return bf - af || bl - al || bp - ap;
  });

  const winner = sorted[0].name;
  const variants = [...new Set(named.map((r) => r.name))];
  if (variants.length > 1) {
    issues.push({
      issue_type: 'name_variants_merged',
      severity: 'low',
      raw_value: variants.join(' / '),
      action_taken: `Kept the most complete form "${winner}"`,
      detail: `Same person written ${variants.length} different ways across sources (${named.map(label).join(', ')})`,
      source_file: sorted[0].sourceFile,
      source_row: sorted[0].sourceRow,
      column_name: 'name',
    });
  }
  return winner;
}

/**
 * City by majority vote, tie broken by source priority.
 * Voting rather than "source1 wins" because two sources agreeing against one is
 * better evidence than one source being nominally more authoritative.
 */
function bestCity(recs, issues) {
  const votes = new Map();
  for (const r of recs) {
    if (!r.city) continue;
    if (!votes.has(r.city)) votes.set(r.city, []);
    votes.get(r.city).push(r);
  }
  if (!votes.size) return null;

  const ranked = [...votes.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;         // most votes
    return Math.min(...a[1].map((r) => priorityOf(r.sourceFile)))              // then priority
         - Math.min(...b[1].map((r) => priorityOf(r.sourceFile)));
  });

  const winner = ranked[0][0];
  if (votes.size > 1) noteConflict(issues, recs, 'city', 'city', winner);
  return winner;
}

/** Pick the primary email, preferring the plainest form when a person has several. */
function bestEmail(recs, issues) {
  const emails = [...new Set(recs.map((r) => r.email).filter(Boolean))];
  if (!emails.length) return { primary: null, all: [] };

  // 'alt.nikhil.chopra70@' vs 'nikhil.chopra70@' - the shorter, unprefixed
  // address is the canonical one; the alias is still kept as an identifier.
  const sorted = [...emails].sort((a, b) => {
    const aAlt = /^alt\./.test(a) ? 1 : 0;
    const bAlt = /^alt\./.test(b) ? 1 : 0;
    return aAlt - bAlt || a.length - b.length || a.localeCompare(b);
  });

  if (emails.length > 1) {
    issues.push({
      issue_type: 'multiple_emails_one_person',
      severity: 'medium',
      raw_value: emails.join(' / '),
      action_taken: `Primary set to ${sorted[0]}, all addresses kept in person_identifiers`,
      detail: 'One human holding more than one email address across the source systems',
      source_file: recs[0].sourceFile,
      source_row: recs[0].sourceRow,
      column_name: 'email',
    });
  }
  return { primary: sorted[0], all: sorted };
}

/**
 * @param {Array} cluster staged records that were matched together
 * @param {{confidence:string, reasons:string[]}} meta
 * @returns {{person:object, identifiers:Array, skills:Array, sources:Array, issues:Array}}
 */
export function buildGoldenRecord(cluster, meta) {
  const issues = [];
  const recs = [...cluster].sort((a, b) => priorityOf(a.sourceFile) - priorityOf(b.sourceFile));

  const { primary: primaryEmail, all: allEmails } = bestEmail(recs, issues);
  const allPhones = [...new Set(recs.map((r) => r.phone).filter(Boolean))];
  if (allPhones.length > 1) {
    issues.push({
      issue_type: 'multiple_phones_one_person',
      severity: 'medium',
      raw_value: allPhones.join(' / '),
      action_taken: `Primary set to ${allPhones[0]}, all numbers kept in person_identifiers`,
      detail: 'One human holding more than one phone number across the source systems',
      source_file: recs[0].sourceFile,
      source_row: recs[0].sourceRow,
      column_name: 'phone',
    });
  }

  // Field ownership.
  const experience = pick(recs, 'experienceYears', 'source1_naukri_applicants.csv');
  const ctc        = pick(recs, 'ctcInr',          'source1_naukri_applicants.csv');
  const applied    = pick(recs, 'appliedDate',     'source1_naukri_applicants.csv');
  const rate       = pick(recs, 'ratePerHour',     'source2_gig_workers.csv');
  const rateRaw    = pick(recs, 'rateRaw',         'source2_gig_workers.csv');
  const verified   = pick(recs, 'isVerified',      'source3_cbnexus_contacts.csv');
  const projects   = pick(recs, 'projectsCompleted', 'source3_cbnexus_contacts.csv');

  const statusRecs = from(recs, 'source2_gig_workers.csv');
  const status = statusRecs.length ? (pick(statusRecs, 'status').value ?? 'unknown') : 'unknown';

  // Conflicts worth reporting even though ownership decides the winner.
  noteConflict(issues, recs, 'experienceYears', 'experience_years', experience.value);
  noteConflict(issues, recs, 'ctcInr', 'current_ctc_inr', ctc.value);

  const person = {
    full_name: bestName(recs, issues),
    primary_email: primaryEmail,
    primary_phone: allPhones[0] ?? null,
    city: bestCity(recs, issues),
    experience_years: experience.value,
    current_ctc_inr: ctc.value,
    rate_inr_per_hour: rate.value,
    rate_raw: rateRaw.value,
    gig_status: status,
    is_verified: verified.value,
    projects_completed: projects.value,
    applied_date: applied.value,
    skill_category: null,                 // filled in by the n8n flow (Task 2)
    match_confidence: meta.confidence,
    match_reason: meta.reasons.length ? meta.reasons.join('; ') : 'only appears in one source',
  };

  const identifiers = [
    ...allEmails.map((v) => ({
      id_type: 'email',
      value: v,
      source_file: recs.find((r) => r.email === v).sourceFile,
      is_primary: v === primaryEmail ? 1 : 0,
    })),
    ...allPhones.map((v) => ({
      id_type: 'phone',
      value: v,
      source_file: recs.find((r) => r.phone === v).sourceFile,
      is_primary: v === allPhones[0] ? 1 : 0,
    })),
  ];

  // Union of skills across every source row for this person.
  const skillMap = new Map();
  for (const r of recs) for (const s of r.skills) if (!skillMap.has(s.match_key)) skillMap.set(s.match_key, s);

  const sources = recs.map((r) => ({
    source_file: r.sourceFile,
    source_row: r.sourceRow,
    raw_json: JSON.stringify(r.raw),
  }));

  return { person, identifiers, skills: [...skillMap.values()], sources, issues };
}
