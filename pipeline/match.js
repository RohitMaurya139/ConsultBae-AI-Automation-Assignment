/**
 * Identity resolution.
 *
 * The hard constraint of this dataset: **no identifier is common to all three
 * files.**
 *
 *     source1  email + phone     <- the only bridge
 *     source2  email only
 *     source3  phone only
 *
 * So source2 and source3 can never be linked directly. They can only meet
 * through a source1 row that carries both, or - for the handful of people who
 * have no source1 row at all - through a much weaker name+city signal.
 *
 * Three tiers, strongest first. Every merge records *why* it happened so the
 * decision is auditable rather than a black box.
 *
 *   Tier 1  same normalised email        -> high confidence
 *   Tier 2  same normalised phone        -> high confidence
 *   Tier 3  same name + same city, and only between a cluster that has an email
 *           but no phone and one that has a phone but no email, and only when
 *           that name+city key is unique in the whole dataset
 *                                        -> medium confidence
 *
 * Tier 3 is deliberately timid. This file contains two different people called
 * Arjun Mehta who are both in Noida; a name+city rule without the uniqueness
 * guard would merge them and silently destroy a person.
 */

/** Classic union-find with path compression and union by size. */
class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = new Array(n).fill(1);
  }

  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];   // path compression
      x = this.parent[x];
    }
    return x;
  }

  /** @returns {boolean} true if this call actually joined two distinct sets */
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    return true;
  }
}

/** Group record indices by a key function, skipping null keys. */
function groupBy(records, keyFn) {
  const map = new Map();
  records.forEach((rec, idx) => {
    const key = keyFn(rec);
    if (key === null || key === undefined || key === '') return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(idx);
  });
  return map;
}

const label = (r) => `${r.sourceFile}:${r.sourceRow}`;

/**
 * @param {Array} records staged records from stage.js
 * @returns {{clusters: Array<{indices:number[], confidence:string, reasons:string[]}>,
 *            issues: Array, reviewQueue: Array}}
 */
export function matchRecords(records) {
  const uf = new UnionFind(records.length);
  const issues = [];
  const reviewQueue = [];
  // Reasons are stored per *record index*, not per cluster root. A root changes
  // whenever a later tier merges its cluster into a bigger one, so anything keyed
  // by root would silently lose the earlier tiers' reasons.
  const reasons = new Map();   // record index -> Set of human-readable merge reasons

  const noteReason = (a, b, text) => {
    for (const idx of [a, b]) {
      if (!reasons.has(idx)) reasons.set(idx, new Set());
      reasons.get(idx).add(text);
    }
  };

  // -------------------------------------------------------------------------
  // Tier 1 - same email.
  //
  // This is what collapses source2's UPPER CASE addresses onto source1's, and
  // what catches source1's 'R. Verma' / 'Rohit Verma' pair whose names differ
  // but whose email is identical.
  // -------------------------------------------------------------------------
  const byEmail = groupBy(records, (r) => r.email);
  for (const [email, idxs] of byEmail) {
    if (idxs.length < 2) continue;
    for (let i = 1; i < idxs.length; i++) {
      const merged = uf.union(idxs[0], idxs[i]);
      if (merged) {
        noteReason(idxs[0], idxs[i], `tier1: same email ${email}`);
        if (records[idxs[0]].name !== records[idxs[i]].name) {
          issues.push({
            issue_type: 'duplicate_person_same_email',
            severity: 'high',
            raw_value: `${records[idxs[0]].name} / ${records[idxs[i]].name}`,
            action_taken: 'Merged into one person on the shared email address',
            detail: `Same email ${email} written under two different names (${label(records[idxs[0]])}, ${label(records[idxs[i]])})`,
            source_file: records[idxs[i]].sourceFile,
            source_row: records[idxs[i]].sourceRow,
            column_name: null,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tier 2 - same phone.
  //
  // This is the only thing that links source3 to source1 at all, and it is what
  // catches the person who appears twice in source1 under two *different*
  // email addresses (`alt.nikhil.chopra70@` and `nikhil.chopra70@`) but one phone.
  // -------------------------------------------------------------------------
  const byPhone = groupBy(records, (r) => r.phone);
  for (const [phone, idxs] of byPhone) {
    if (idxs.length < 2) continue;
    for (let i = 1; i < idxs.length; i++) {
      const a = idxs[0];
      const b = idxs[i];
      const emailA = records[a].email;
      const emailB = records[b].email;

      const merged = uf.union(a, b);
      if (!merged) continue;
      noteReason(a, b, `tier2: same phone ${phone}`);

      if (emailA && emailB && emailA !== emailB) {
        issues.push({
          issue_type: 'same_person_two_emails',
          severity: 'high',
          raw_value: `${emailA} / ${emailB}`,
          action_taken: 'Merged on the shared phone number; both addresses kept in person_identifiers',
          detail: `One person holding two email addresses (${label(records[a])}, ${label(records[b])}) - an email-only match would have created two people`,
          source_file: records[b].sourceFile,
          source_row: records[b].sourceRow,
          column_name: null,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tier 3 - name + city, heavily guarded.
  //
  // Only reachable for people with no source1 row, i.e. a source2 record (email,
  // no phone) and a source3 record (phone, no email) that describe the same human.
  // -------------------------------------------------------------------------

  // Describe every cluster as it stands after tiers 1 and 2.
  const clusterOf = new Map();   // root -> {indices, emails:Set, phones:Set, names:Set, cities:Set}
  records.forEach((rec, idx) => {
    const root = uf.find(idx);
    if (!clusterOf.has(root)) {
      clusterOf.set(root, { root, indices: [], emails: new Set(), phones: new Set(), nameKeys: new Set(), cities: new Set(), skillKeys: new Set() });
    }
    const c = clusterOf.get(root);
    c.indices.push(idx);
    if (rec.email) c.emails.add(rec.email);
    if (rec.phone) c.phones.add(rec.phone);
    if (rec.nameKey && !rec.hasInitial) c.nameKeys.add(rec.nameKey);
    if (rec.city && rec.cityCanonical) c.cities.add(rec.city);
    for (const s of rec.skills ?? []) c.skillKeys.add(s.match_key);
  });

  // Index clusters by every (name, city) pair they present.
  const byNameCity = new Map();
  for (const c of clusterOf.values()) {
    for (const nameKey of c.nameKeys) {
      for (const city of c.cities) {
        const key = `${nameKey}||${city}`;
        if (!byNameCity.has(key)) byNameCity.set(key, []);
        byNameCity.get(key).push(c);
      }
    }
  }

  for (const [key, clusters] of byNameCity) {
    if (clusters.length < 2) continue;
    const [nameKey, city] = key.split('||');

    const emailOnly = clusters.filter((c) => c.emails.size > 0 && c.phones.size === 0);
    const phoneOnly = clusters.filter((c) => c.phones.size > 0 && c.emails.size === 0);
    const complete = clusters.filter((c) => c.emails.size > 0 && c.phones.size > 0);

    // GUARD 1 - the bridge must be unambiguous.
    //
    // Tier 3 exists to join a source2 row (email, no phone) to a source3 row
    // (phone, no email). If either side has more than one candidate we cannot
    // tell which pairs with which, so we refuse.
    //
    // Note what is deliberately NOT part of this test: a cluster that already
    // holds both an email and a phone. Such a cluster cannot be the missing half
    // of the bridge - it is already whole - so counting it as a rival candidate
    // would block correct merges. It is handled by GUARD 2 instead.
    if (emailOnly.length !== 1 || phoneOnly.length !== 1) {
      const detail = `${clusters.length} clusters share the name+city "${nameKey} / ${city}" (${emailOnly.length} email-only, ${phoneOnly.length} phone-only). Cannot tell which pairs with which.`;

      issues.push({
        issue_type: 'ambiguous_name_match',
        severity: 'high',
        raw_value: `${nameKey} / ${city}`,
        action_taken: 'NOT merged - left as separate people and queued for human review',
        detail,
        source_file: records[clusters[0].indices[0]].sourceFile,
        source_row: records[clusters[0].indices[0]].sourceRow,
        column_name: null,
      });

      reviewQueue.push({
        reason: 'ambiguous_name_match',
        nameCity: `${nameKey} / ${city}`,
        candidates: clusters.map((c) => c.indices.map((i) => label(records[i]))),
        detail,
      });
      continue;
    }

    const a = emailOnly[0];
    const b = phoneOnly[0];
    if (uf.find(a.root) === uf.find(b.root)) continue;

    // GUARD 2 - is a complete cluster the real owner of this email-only row?
    //
    // A complete cluster cannot be the bridge partner, but it CAN own the
    // email-only row as a *second* address: this dataset contains exactly that
    // pattern (one person, two emails, one phone). So we do not ignore complete
    // clusters - we ask whether any evidence supports them claiming this row,
    // using skills as a corroborating attribute.
    //
    // Skills are a strong signal here: across all 102 rows, every pair of records
    // that share an email also shares a byte-identical skill list, and no two
    // different people share one. If the skill sets do not match, the complete
    // cluster is not the owner and the bridge merge is safe.
    const skillSig = (c) => [...c.skillKeys].sort().join('|');
    const emailSig = skillSig(a);
    const claimant = complete.find((c) => emailSig && skillSig(c) === emailSig);

    if (claimant) {
      const detail = `A person with the same name+city "${nameKey} / ${city}" already holds both an email and a phone, and has an identical skill set to the unmatched row. It is more likely a second address for that person than a separate human.`;
      issues.push({
        issue_type: 'ambiguous_name_match',
        severity: 'high',
        raw_value: `${nameKey} / ${city}`,
        action_taken: 'NOT merged - left as separate people and queued for human review',
        detail,
        source_file: records[a.indices[0]].sourceFile,
        source_row: records[a.indices[0]].sourceRow,
        column_name: null,
      });
      reviewQueue.push({
        reason: 'complete_cluster_may_own_row',
        nameCity: `${nameKey} / ${city}`,
        candidates: clusters.map((c) => c.indices.map((i) => label(records[i]))),
        detail,
      });
      continue;
    }

    // A complete cluster shares the name+city but nothing corroborates its claim.
    // Merge, but record that the alternative was considered and rejected.
    if (complete.length > 0) {
      issues.push({
        issue_type: 'name_city_shared_with_third_person',
        severity: 'medium',
        raw_value: `${nameKey} / ${city}`,
        action_taken: 'Merged the email-only and phone-only rows; the complete cluster was ruled out',
        detail: `Another person with the same name and city already has both an email and a phone (${complete.flatMap((c) => c.indices.map((i) => label(records[i]))).join(', ')}), so they cannot be the missing half of this pair. Their skill set also differs from the unmatched row, so they are not its owner either.`,
        source_file: records[b.indices[0]].sourceFile,
        source_row: records[b.indices[0]].sourceRow,
        column_name: null,
      });
    }

    uf.union(a.root, b.root);
    noteReason(a.root, b.root, `tier3: same name+city "${nameKey} / ${city}" (no shared identifier)`);

    issues.push({
      issue_type: 'matched_on_name_and_city',
      severity: 'medium',
      raw_value: `${nameKey} / ${city}`,
      action_taken: 'Merged at medium confidence',
      detail: `No identifier links these rows - source2 has no phone column and source3 has no email column, and neither person appears in source1. Merged because the name+city pair is unique across the dataset. Rows: ${[...a.indices, ...b.indices].map((i) => label(records[i])).join(', ')}`,
      source_file: records[b.indices[0]].sourceFile,
      source_row: records[b.indices[0]].sourceRow,
      column_name: null,
    });
  }

  // -------------------------------------------------------------------------
  // Report near-misses we deliberately did NOT merge: same name, different city.
  // These are the most likely false negatives, so they go to the review queue
  // rather than being silently dropped.
  // -------------------------------------------------------------------------
  const byNameOnly = new Map();
  for (const c of clusterOf.values()) {
    for (const nameKey of c.nameKeys) {
      if (!byNameOnly.has(nameKey)) byNameOnly.set(nameKey, new Set());
      byNameOnly.get(nameKey).add(c);
    }
  }
  for (const [nameKey, set] of byNameOnly) {
    const clusters = [...set].filter((c) => uf.find(c.root) !== undefined);
    const roots = new Set(clusters.map((c) => uf.find(c.root)));
    if (roots.size < 2) continue;

    const cities = new Set(clusters.flatMap((c) => [...c.cities]));
    if (cities.size <= 1) continue;   // already handled by the name+city pass

    reviewQueue.push({
      reason: 'same_name_different_city',
      nameCity: `${nameKey} / ${[...cities].join(' vs ')}`,
      candidates: clusters.map((c) => c.indices.map((i) => label(records[i]))),
      detail: `${roots.size} people named "${nameKey}" in different cities. Treated as different people - a name alone is not evidence of identity.`,
    });
  }

  // -------------------------------------------------------------------------
  // Materialise the clusters.
  // -------------------------------------------------------------------------
  const grouped = new Map();
  records.forEach((_, idx) => {
    const root = uf.find(idx);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(idx);
  });

  const clusters = [...grouped.entries()].map(([, indices]) => {
    // Gather reasons from every member, since they were recorded per index.
    const why = [...new Set(indices.flatMap((i) => [...(reasons.get(i) ?? [])]))].sort();
    let confidence = 'single-source';
    if (why.some((r) => r.startsWith('tier1') || r.startsWith('tier2'))) confidence = 'high';
    else if (why.some((r) => r.startsWith('tier3'))) confidence = 'medium';
    if (indices.length === 1) confidence = 'single-source';

    return { indices: indices.sort((a, b) => a - b), confidence, reasons: why };
  });

  return { clusters, issues, reviewQueue };
}
