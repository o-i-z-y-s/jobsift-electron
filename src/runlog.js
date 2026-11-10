'use strict';

/**
 * src/runlog.js
 * One small text log per run, in the Logs folder of the app data folder
 * (run-YYYY-MM-DD_HH-MM.log), saying what the run did and how each request
 * went: its settings, each step's progress, every Jobright page opened with
 * its HTTP status and time, each company board's result, the requests made
 * per site by status, and how the run ended. The newest KEEP files are kept.
 *
 * While a log is open, everything written with console.log and console.error
 * goes into it too, so the scrapers' own lines need no second call.
 * Nothing about a person is written: no connection's name ever reaches a log.
 *
 * No Electron dependency, so this module can be tested directly with node.
 */

const fs   = require('fs');
const path = require('path');

const KEEP = 30;
const NAME_RE = /^run-.*\.log$/;

let file = null;
let consoleWas = null;

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Writes one line, with the time, when a log is open. */
function log(message) {
  if (!file) return;
  const text = String(message).replace(/^\n+/, '').replace(/\s+$/, '');
  if (!text) return;
  try { fs.appendFileSync(file, text.split('\n').map(l => `${stamp()} ${l}`).join('\n') + '\n', 'utf8'); }
  catch { /* a log that cannot be written must not stop the run */ }
}

/**
 * A progress message of a run. A count that only moves forward ("12/40") is
 * left out: each request it counts has its own line.
 */
function progress(step, message) {
  if (message && !/\d+\s*\/\s*\d+\s*$/.test(message)) log(`[${step}] ${message}`);
}

/** Opens the log of the run started at ts (the run's file timestamp) and returns its path. */
function open(dir, ts) {
  close();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const old = fs.readdirSync(dir).filter(n => NAME_RE.test(n)).sort().reverse().slice(KEEP - 1);
    for (const n of old) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* left for the next run */ } }
    file = path.join(dir, `run-${ts}.log`);
  } catch { file = null; return null; }
  consoleWas = { log: console.log, error: console.error };
  const tee = (fn, mark) => (...args) => {
    fn(...args);
    log(mark + args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log   = tee(consoleWas.log, '');
  console.error = tee(consoleWas.error, 'ERROR ');
  return file;
}

/** Closes the open log, if any. */
function close() {
  if (consoleWas) { console.log = consoleWas.log; console.error = consoleWas.error; consoleWas = null; }
  file = null;
}

/**
 * Counts requests by site and HTTP status. count(url, status) records one
 * ("failed" for a request with no answer); lines() gives one line per site,
 * busiest first: "jobright.ai: 412 requests - 200 x398, 304 x14".
 */
function tally() {
  const sites = new Map();
  return {
    count(url, status) {
      let host = '';
      try { host = new URL(url).hostname; } catch { return; }
      if (!sites.has(host)) sites.set(host, new Map());
      const s = sites.get(host);
      s.set(String(status), (s.get(String(status)) || 0) + 1);
    },
    total() { return [...sites.values()].reduce((n, s) => n + [...s.values()].reduce((a, b) => a + b, 0), 0); },
    lines() {
      const sum = s => [...s.values()].reduce((a, b) => a + b, 0);
      return [...sites.entries()].sort((a, b) => sum(b[1]) - sum(a[1])).map(([host, s]) =>
        `${host}: ${sum(s)} request${sum(s) === 1 ? '' : 's'} - ` + [...s.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', '));
    },
  };
}

module.exports = { open, close, log, progress, tally };
