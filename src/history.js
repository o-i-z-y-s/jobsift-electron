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
 *   Roles shown         The roles earlier runs accepted, and so already
 *                       showed, kept in a small index so the saved results
 *                       are not all read again on every run.
 *   Jobright refusals   When Jobright last turned a request away, so it is
 *                       left alone for REST_MINUTES after.
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
const SHOWN_FILE = 'shown_index.json';
const REFUSED_FILE = 'jobright_refused.json';
// How long Jobright is left alone after it turns a request away.
const REST_MINUTES = 30;

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

// ── Jobright refusals ────────────────────────────────────────────────────────

/** Records that Jobright turned a request away now. */
function noteRefused(dir, now = Date.now()) {
  try { fs.writeFileSync(path.join(dir, REFUSED_FILE), JSON.stringify({ at: now }), 'utf8'); } catch { /* not kept */ }
}

/** Until when Jobright is left alone (milliseconds), or 0 when it may be searched. */
function restingUntil(dir, now = Date.now()) {
  try {
    const at = JSON.parse(fs.readFileSync(path.join(dir, REFUSED_FILE), 'utf8')).at;
    const until = at + REST_MINUTES * 60000;
    return Number.isFinite(at) && at <= now && until > now ? until : 0;
  } catch { return 0; }
}

// ── Roles shown ──────────────────────────────────────────────────────────────

/**
 * The roles accepted by the saved results in resultsDir that were judged by
 * this evaluator, each as pick(role) made it. They come from an index in
 * indexDir that holds every results file's roles; only a results file that is
 * new or has changed is read, and a deleted one drops out, so its roles can be
 * shown again.
 */
function shown(resultsDir, indexDir, pick, evaluator) {
  const indexFile = path.join(indexDir, SHOWN_FILE);
  let before = {};
  try { before = JSON.parse(fs.readFileSync(indexFile, 'utf8')).files || {}; } catch { /* first use */ }
  let names = [];
  try { names = fs.readdirSync(resultsDir).filter(n => n.endsWith('.json')); } catch { /* no results yet */ }
  const files = {};
  let changed = Object.keys(before).length !== names.length;
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(resultsDir, name));
      const cur = before[name];
      if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size) { files[name] = cur; continue; }
      const run = JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8'));
      files[name] = { mtimeMs: st.mtimeMs, size: st.size, evaluator: run?.evaluator || '', roles: (run?.accepted?.roles || []).map(pick) };
      changed = true;
    } catch { changed = true; /* a malformed file is skipped, and tried again next run */ }
  }
  if (changed) {
    try { fs.writeFileSync(indexFile, JSON.stringify({ version: 1, files }), 'utf8'); } catch { /* rebuilt next run */ }
  }
  return Object.values(files).filter(f => evaluator && f.evaluator === evaluator).flatMap(f => f.roles);
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

module.exports = { KEEP_DAYS, rawName, jobright, boards, prune, partial, shown, noteRefused, restingUntil, settingsKey, coverage, daysToSearch, saveCoverage };
