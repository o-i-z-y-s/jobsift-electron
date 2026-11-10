'use strict';

/**
 * src/history.js
 * What earlier runs already fetched, so a run requests nothing twice. Each run
 * saves the raw records of its sources in the staging folder; this module
 * reads them back, and keeps them for KEEP_DAYS.
 *
 *   Jobright postings   A posting read in an earlier run is not opened again,
 *                       and one found closed is not opened again either.
 *                       Postings are also appended to a partial file as they
 *                       are read, so a run that ends early keeps its reads.
 *   Company boards      A posting whose text was downloaded in an earlier run
 *                       is not downloaded again (see scraper/ats-http.js).
 *   Jobright coverage   The stretch of time Jobright has been searched for
 *                       with the current settings, so a scheduled run searches
 *                       only back to the last completed run.
 *
 * No Electron dependency, so this module can be tested directly with node.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// The longest period a run can search, so every posting a run can find again
// is still on file.
const KEEP_DAYS = 30;
const DAY = 86400000;
const COVERAGE_FILE = 'jobright_coverage.json';

const rawName     = (source, ts) => `job-search-${source}-${ts}.json`;
const partialName = (source, ts) => `job-search-${source}-${ts}.partial.jsonl`;

// Every record a source saved in the last KEEP_DAYS, oldest file first.
function* records(dir, source, now) {
  const mine = new RegExp(`^job-search-${source}-.*\\.(?:json|jsonl)$`);
  let files = [];
  try { files = fs.readdirSync(dir).filter(n => mine.test(n)).sort(); }
  catch { return; }
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).mtimeMs < now - KEEP_DAYS * DAY) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (f.endsWith('.jsonl')) {
        for (const line of text.split('\n')) {
          // A run that ended mid-write leaves a cut-off last line.
          try { if (line.trim()) yield JSON.parse(line); } catch { /* skip the line */ }
        }
      } else {
        yield* JSON.parse(text);
      }
    } catch { /* skip unreadable files */ }
  }
}

/**
 * The Jobright postings of earlier runs, by jid; the latest read wins.
 *   read    Map of jid to the record of a posting read in full
 *   closed  Set of the jids of postings found closed or removed
 * Cards rejected without being opened and postings that failed to load are in
 * neither.
 */
function jobright(dir, now = Date.now()) {
  const read = new Map(), closed = new Set();
  for (const r of records(dir, 'jobright', now)) {
    if (!r?.jid) continue;
    if (r.is_closed) { closed.add(r.jid); read.delete(r.jid); }
    else if (!r.avoided && !r.error && (r.responsibilities || r.required_quals || r.body_text)) {
      read.set(r.jid, r);
      closed.delete(r.jid);
    }
  }
  return { read, closed };
}

/** The company-board postings whose text an earlier run downloaded, by jid. */
function boards(dir, now = Date.now()) {
  const read = new Map();
  for (const r of records(dir, 'ats-http', now)) {
    if (r?.jid && !r.avoided && !r.error && (r.responsibilities || r.required_quals || r.preferred_quals)) read.set(r.jid, r);
  }
  return read;
}

/** Deletes the staging files older than KEEP_DAYS. */
function prune(dir, now = Date.now()) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(n => /^job-search-.*\.(?:json|jsonl)$/.test(n)); }
  catch { return; }
  for (const f of files) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < now - KEEP_DAYS * DAY) fs.unlinkSync(p); } catch { /* left for the next run */ }
  }
}

/**
 * A source's partial file for the run started at ts: add(record) appends one
 * record as it is read; remove() deletes the file once the run's raw file is
 * saved. A failed write costs only that record's place in the file.
 */
function partial(dir, source, ts) {
  const file = path.join(dir, partialName(source, ts));
  return {
    add(record) { try { fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8'); } catch { /* not kept */ } },
    remove()    { try { fs.unlinkSync(file); } catch { /* none was written */ } },
  };
}

// ── Jobright coverage ────────────────────────────────────────────────────────
// { key, from, to }: with the settings that hash to key, Jobright has been
// searched for every posting made between from and to (milliseconds).

/** The settings a run searches and judges with, as one hash. */
function settingsKey(cfg, evaluator = '') {
  const own = Object.fromEntries(Object.entries(cfg || {}).filter(([k]) => !k.startsWith('_') && k !== 'migration_notes'));
  return crypto.createHash('sha256').update(JSON.stringify(own)).update(String(evaluator)).digest('hex').slice(0, 16);
}

function coverage(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, COVERAGE_FILE), 'utf8'));
    return c && typeof c.key === 'string' && Number.isFinite(c.from) && Number.isFinite(c.to) ? c : null;
  } catch { return null; }
}

/**
 * How many days back a run at `now` needs to search Jobright to have covered
 * the past `days`: only back to the last completed run, plus a quarter day
 * for postings Jobright lists late, when that run and the ones before it
 * already cover the rest with these same settings. Otherwise all of `days`.
 */
function daysToSearch(cov, key, days, now = Date.now()) {
  if (!cov || cov.key !== key || cov.to > now || cov.from > now - days * DAY) return days;
  return Math.min(days, Math.max(1, Math.ceil((now - cov.to) / DAY + 0.25)));
}

/**
 * Records a completed Jobright run that started at `started` and searched the
 * `days` before it. The stretch joins the one on file when they meet and the
 * settings are the same; otherwise it replaces it.
 */
function saveCoverage(dir, cov, key, days, started) {
  let from = started - days * DAY;
  if (cov && cov.key === key && from <= cov.to) from = Math.min(from, cov.from);
  try { fs.writeFileSync(path.join(dir, COVERAGE_FILE), JSON.stringify({ key, from, to: started }), 'utf8'); }
  catch { /* the next run searches its whole period */ }
}

module.exports = { KEEP_DAYS, rawName, jobright, boards, prune, partial, settingsKey, coverage, daysToSearch, saveCoverage };
