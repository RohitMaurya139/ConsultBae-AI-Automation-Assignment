/**
 * Structural cleaning - problems with the *shape* of a row, before any field
 * is normalised.
 *
 * The three source files each carry a different structural defect:
 *   source1: a byte-identical duplicate row, and a row whose name is abbreviated
 *   source2: one completely blank row, and one row whose columns are rotated
 *   source3: the header line repeated in the middle of the file
 *
 * Row numbers reported here are 1-based line numbers in the original CSV, so an
 * issue in the report can be opened directly in the file.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

const issue = (type, severity, rawValue, action, detail, row, column) => ({
  issue_type: type,
  severity,
  raw_value: rawValue === undefined || rawValue === null ? null : String(rawValue),
  action_taken: action,
  detail: detail ?? null,
  source_row: row ?? null,
  column_name: column ?? null,
});

const looksLikeEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/**
 * Parse a CSV into positional cell arrays, keeping the original line number.
 *
 * `relax_column_count` is essential: the malformed rows have the wrong number of
 * fields, and the default parser aborts the whole file on the first one. We want
 * to see them, not crash on them.
 */
function readRows(filePath) {
  const text = readFileSync(filePath, 'utf8');
  return parse(text, {
    skip_empty_lines: false,   // a blank line IS a finding - do not hide it
    relax_column_count: true,
    relax_quotes: true,
    trim: false,               // trailing spaces in 'Noida ' are findings too
  });
}

/**
 * source2's rotated row:
 *   normal : email_id, worker_name, rate,      location, status, skill_tags
 *   broken : skill_tags, email_id, worker_name, rate,    location, status
 *
 * Detected structurally rather than by matching the known bad string: column 0
 * is not an email but column 1 is, which can only happen if the fields shifted
 * right by one. Rotating left by one restores the header order.
 */
function repairRotation(cells, emailIndex) {
  if (cells.length < 2) return null;
  const shift = cells.findIndex(looksLikeEmail);
  if (shift <= emailIndex) return null;          // email already at/before its column
  const offset = shift - emailIndex;
  return [...cells.slice(offset), ...cells.slice(0, offset)];
}

/**
 * @param {string} filePath
 * @param {{name: string, header: string[], emailIndex: number|null}} spec
 * @returns {{rows: Array<{sourceRow:number, data:object}>, issues: Array<object>}}
 */
export function loadSource(filePath, spec) {
  const { name, header, emailIndex } = spec;
  const all = readRows(filePath);
  const issues = [];
  const rows = [];
  const seenRaw = new Map();   // byte-identical duplicate detection, within this file

  const headerKey = header.map((h) => h.trim().toLowerCase()).join('|');

  all.forEach((cells, idx) => {
    const sourceRow = idx + 1;                     // 1-based, matches the file
    if (sourceRow === 1) return;                   // the real header

    const joined = cells.map((c) => (c ?? '').trim()).join('|');

    // --- completely blank row -------------------------------------------
    if (cells.every((c) => (c ?? '').trim() === '')) {
      issues.push(issue('blank_row', 'medium', null,
        'Row dropped', 'Every field empty', sourceRow, null));
      return;
    }

    // --- header repeated mid-file ---------------------------------------
    if (joined.toLowerCase() === headerKey) {
      issues.push(issue('repeated_header', 'high', joined,
        'Row dropped', 'Header line repeated inside the data - would otherwise be ingested as a person named "Name"', sourceRow, null));
      return;
    }

    // --- wrong field count / rotated columns ----------------------------
    let working = cells;
    if (cells.length !== header.length) {
      issues.push(issue('column_count_mismatch', 'high', joined,
        'Row inspected for column shift',
        `Expected ${header.length} fields, found ${cells.length}`, sourceRow, null));
    }

    if (emailIndex !== null && !looksLikeEmail(cells[emailIndex])) {
      const repaired = repairRotation(cells, emailIndex);
      if (repaired) {
        issues.push(issue('column_shift', 'high', joined,
          `Rotated fields back into header order -> ${repaired.map((c) => (c ?? '').trim()).join('|')}`,
          'Column 0 was not an email but a later column was, so the fields had shifted right by one', sourceRow, null));
        working = repaired;
      } else {
        issues.push(issue('column_shift_unrepairable', 'high', joined,
          'Row dropped', 'No email found in any column - cannot determine the correct field order', sourceRow, null));
        return;
      }
    }

    // --- byte-identical duplicate within the same file ------------------
    const dupKey = working.map((c) => (c ?? '').trim().toLowerCase()).join('|');
    if (seenRaw.has(dupKey)) {
      issues.push(issue('duplicate_row_in_source', 'high', joined,
        `Row dropped as a duplicate of row ${seenRaw.get(dupKey)}`,
        'Identical field-for-field after trimming and lower-casing', sourceRow, null));
      return;
    }
    seenRaw.set(dupKey, sourceRow);

    // --- build the record ------------------------------------------------
    const data = {};
    header.forEach((col, i) => { data[col] = working[i] ?? null; });

    // Extra fields beyond the header would be silently lost otherwise.
    if (working.length > header.length) {
      issues.push(issue('extra_fields', 'medium', working.slice(header.length).join('|'),
        'Extra trailing fields discarded',
        `Row had ${working.length} fields, header defines ${header.length}`, sourceRow, null));
    }

    rows.push({ sourceRow, data, sourceFile: name });
  });

  return { rows, issues };
}

/** The three files, described the way the loader needs them. */
export const SOURCES = [
  {
    name: 'source1_naukri_applicants.csv',
    path: 'data/raw/source1_naukri_applicants.csv',
    header: ['Full Name', 'Email', 'Phone', 'City', 'Experience (Years)', 'Current CTC', 'Applied Date', 'Skills'],
    emailIndex: 1,
  },
  {
    name: 'source2_gig_workers.csv',
    path: 'data/raw/source2_gig_workers.csv',
    header: ['email_id', 'worker_name', 'rate', 'location', 'status', 'skill_tags'],
    emailIndex: 0,
  },
  {
    name: 'source3_cbnexus_contacts.csv',
    path: 'data/raw/source3_cbnexus_contacts.csv',
    header: ['Name', 'Phone Number', 'City', 'Verified', 'Projects Completed'],
    emailIndex: null,   // source3 has no email column at all
  },
];
