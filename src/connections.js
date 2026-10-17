'use strict';

/**
 * src/connections.js
 * The user's LinkedIn connections: reading LinkedIn's export, the company-name
 * cleanup used for every company comparison, and the matching index.
 *
 *   Reading     LinkedIn's Connections.csv has note lines above the header and
 *               quoted fields that can hold commas, quotes, and line breaks. The
 *               header row is found by column name, not position. Only each
 *               person's name and company are kept; every other column is
 *               dropped while reading and never stored. Rows with no company
 *               are skipped.
 *   Cleanup     companyKey() lowercases, folds accents, reads "&" as "and",
 *               drops punctuation, a leading "the", and trailing legal endings
 *               (Inc, LLC, Corp ...). Two names match only when their keys are
 *               identical: no fuzzy matching, so a role is never marked as being
 *               at a company where the user knows someone when it is not.
 *   Index       peopleByKey() groups the people under each company key, for the
 *               dashboard badges. companiesByCount() lists the companies, most
 *               connections first, for searching their job boards.
 *
 * Privacy: people's names are only ever read from connections.json to show the
 * dashboard which connections work at a company. Nothing here logs them.
 *
 * No Electron dependency, so this module can be tested directly with node.
 */

const fs   = require('fs');
const path = require('path');

// Legal endings dropped from the end of a company name. Only trailing words are
// dropped, and never the last remaining word, so "Co" alone stays "co".
const LEGAL_ENDINGS = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'gmbh', 'ag', 'sa', 'sas', 'srl', 'bv', 'nv', 'pty', 'pvt', 'ab', 'oy',
]);

const HEADER = { first: 'first name', last: 'last name', company: 'company' };

// ── Company names ───────────────────────────────────────────────────────────

/** The words of a company name after cleanup, or [] for a blank name. */
function companyWords(name) {
  let s = String(name == null ? '' : name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ')
       .replace(/['’.]/g, '')          // "Macy's" -> "macys", "Inc." -> "inc"
       .replace(/[^a-z0-9]+/g, ' ');        // every other mark separates words
  const words = s.split(' ').filter(Boolean);
  if (words.length > 1 && words[0] === 'the') words.shift();
  while (words.length > 1 && LEGAL_ENDINGS.has(words[words.length - 1])) words.pop();
  return words;
}

// What people put in LinkedIn's Company field when they have no employer, or
// will not name one. Compared against the whole cleaned-up name, or each part
// of a name like "Freelance/Contract", so a real company that only starts with
// one of these ("Independent Bank") is kept.
const NOT_COMPANIES = new Set([
  'freelance', 'freelancer', 'freelancing', 'self employed', 'selfemployed', 'self', 'independent',
  'independent consultant', 'independent contractor', 'consultant', 'contractor', 'consulting', 'contract',
  'contracting',
  'stealth', 'stealth mode', 'stealth startup', 'stealth mode startup', 'stealth company', 'confidential',
  'undisclosed', 'private', 'retired', 'student', 'unemployed', 'open to work', 'seeking opportunities',
  'seeking new opportunities', 'looking for opportunities', 'career break', 'sabbatical', 'homemaker',
  'volunteer', 'various', 'n a', 'na', 'none', 'unknown',
]);

/** Whether a company name is a placeholder rather than an employer. */
function notACompany(name) {
  const placeholder = part => { const words = companyWords(part); return words.length > 0 && NOT_COMPANIES.has(words.join(' ')); };
  const parts = String(name || '').split(/[/|,]/).filter(p => companyWords(p).length);
  return placeholder(name) || (parts.length > 1 && parts.every(placeholder));
}

/**
 * The comparison key for a company name. Words are joined without spaces so
 * "Coca-Cola" and "Coca Cola" agree. '' for a blank name.
 */
function companyKey(name) {
  return companyWords(name).join('');
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * Splits CSV text into rows of fields. Handles quoted fields holding commas,
 * doubled quotes and line breaks, a byte order mark, and \r\n, \n, or \r line
 * endings.
 */
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row);
      row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * The people in a LinkedIn connections export: [{ name, company }].
 * Throws when no row has the First Name, Last Name, and Company columns.
 */
function readLinkedInCsv(text) {
  const rows = parseCsv(text);
  const norm = v => String(v || '').trim().toLowerCase();
  const at = rows.findIndex(r => {
    const cols = r.map(norm);
    return Object.values(HEADER).every(h => cols.includes(h));
  });
  if (at < 0) {
    throw new Error('This file does not look like a LinkedIn connections export: ' +
      'no row has the First Name, Last Name, and Company columns.');
  }
  const cols = rows[at].map(norm);
  const col = Object.fromEntries(Object.entries(HEADER).map(([k, h]) => [k, cols.indexOf(h)]));
  const clean = v => String(v || '').replace(/\s+/g, ' ').trim();   // line breaks inside quotes too
  const people = [];
  for (const r of rows.slice(at + 1)) {
    const company = clean(r[col.company]);
    if (!company || !companyKey(company)) continue;
    const name = [r[col.first], r[col.last]].map(clean).filter(Boolean).join(' ');
    if (name) people.push({ name, company });
  }
  return people;
}

// ── Index ───────────────────────────────────────────────────────────────────

/** Map of company key -> [person name], for the dashboard badges. */
function peopleByKey(people) {
  const index = new Map();
  for (const p of people || []) {
    const key = companyKey(p.company);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(p.name);
  }
  return index;
}

/**
 * The connections' companies, most connections first:
 * [{ name, key, count }]. name is the most common spelling.
 */
function companiesByCount(people) {
  const byKey = new Map();
  for (const p of people || []) {
    const key = companyKey(p.company);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { key, count: 0, spellings: new Map() });
    const e = byKey.get(key);
    e.count++;
    e.spellings.set(p.company, (e.spellings.get(p.company) || 0) + 1);
  }
  return [...byKey.values()]
    .map(e => ({ name: [...e.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0], key: e.key, count: e.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ── connections.json ────────────────────────────────────────────────────────
// Lives in the app data folder that the caller passes in. Holds
// { imported_at, people: [{ name, company }] } and nothing else; the CSV
// itself is never copied.

const FILE = 'connections.json';

/** The saved connections, or null when none are imported (or the file is unreadable). */
function load(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return Array.isArray(data.people) ? data : null;
  } catch { return null; }
}

/** Replaces any saved connections with these people. */
function save(dir, people) {
  const data = {
    imported_at: new Date().toISOString(),
    people: people.map(p => ({ name: p.name, company: p.company })),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/** Deletes connections.json. */
function remove(dir) {
  fs.rmSync(path.join(dir, FILE), { force: true });
}

module.exports = {
  companyWords, companyKey, notACompany, readLinkedInCsv, peopleByKey, companiesByCount, load, save, remove,
};
