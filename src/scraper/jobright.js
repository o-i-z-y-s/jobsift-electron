'use strict';

/**
 * src/scraper/jobright.js
 * Collects Jobright listings by driving hidden Electron BrowserWindows and
 * reading the rendered DOM via webContents.executeJavaScript().
 * Session is inherited from session.defaultSession (already authenticated).
 *
 * Each search is filtered by Jobright itself as far as the config allows, every
 * card is judged on what it shows before its posting is opened, and a posting
 * an earlier run read, found closed, or already showed is not opened again.
 * Postings are opened at most MAX_DETAIL_WORKERS at a time, with a pause
 * between them, and the pause grows while postings fail to load. When
 * Jobright refuses a page, answers any request with "too many requests", the
 * session ends, or postings stop loading, nothing more is requested in that
 * run. The hidden windows
 * load no pictures, fonts, media, or third-party tracking scripts, since only
 * the pages' text is read, and a page that does not load in LOAD_TIMEOUT_MS
 * is given up on.
 */

const { BrowserWindow, session } = require('electron');
const { searchPlan, COUNTRY, MAX_DETAIL_WORKERS, MIN_SCROLL_PAUSE_MS, EXPERIENCE_LEVELS } = require('../criteria');
const { cardFields } = require('../sources');
const evalEngine = require('../eval');
const runlog = require('../runlog');

// ── Selectors (verified against live Jobright DOM 2026-04-29) ─────────────────
const SEL_CARD      = '[class*="job-card"]';
const SEL_LINK      = 'a[href*="/jobs/info/"]';
const SEL_SCORE     = '[class*="job-display-score"] [class*="percent-value"]';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Hidden window used to render Jobright pages. It loads a live third-party site,
// so it runs fully locked down: no preload, no Node, OS sandbox on, and web
// content isolated. webContents.executeJavaScript() is unaffected by any of
// these: it evaluates in the page's own world, and contextIsolation only
// governs a preload script, which this window does not have.
function makeHiddenWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });
  const id = win.webContents.id;
  hiddenWindows.add(id);
  win.once('closed', () => hiddenWindows.delete(id));
  return win;
}

// ── Requests the hidden windows skip ──────────────────────────────────────────
// Only a page's text is read, so its pictures, fonts, and media are not
// requested, nor is anything from the advertising and analytics services
// below. Style sheets are kept: what text a page shows depends on them.
const hiddenWindows = new Set();   // webContents ids of the open hidden windows
const SKIPPED_TYPES = new Set(['image', 'media', 'font']);
const TRACKERS = /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|facebook\.net|facebook\.com|bing\.com|clarity\.ms|tiktok\.com|ttwstatic\.com|linkedin\.com|licdn\.com|hotjar\.com|segment\.io|segment\.com|mixpanel\.com|amplitude\.com|sentry\.io|intercom\.io|intercomcdn\.com|fullstory\.com|hs-scripts\.com|hs-analytics\.net|hubspot\.com|twitter\.com|reddit\.com|redditstatic\.com|snapchat\.com|sc-static\.net|criteo\.com|criteo\.net|taboola\.com|outbrain\.com)$/i;

function skipped(d) {
  if (!hiddenWindows.has(d.webContentsId) || d.resourceType === 'mainFrame') return false;
  if (SKIPPED_TYPES.has(d.resourceType)) return true;
  try { return TRACKERS.test(new URL(d.url).hostname); } catch { return false; }
}

/**
 * Watches the app's web requests for the length of a run: skips the ones
 * above in the hidden windows, counts every request by site and status
 * ("cached": answered from the browser cache without asking the site;
 * "skipped": never sent), and stops the run (halt) when Jobright answers any
 * request of a hidden window, a page or the data a page asks for, with HTTP
 * 429. Returns a function that ends the watch and returns the count (a
 * runlog.tally). The count also has sent(), how many requests Jobright's own
 * sites answered so far, and kinds(), those requests by type and address
 * pattern, most frequent first, to show what a page asks for.
 */
function watchRequests(halt) {
  const made = runlog.tally();
  const kinds = new Map();
  let sent = 0;
  // "/jobs/info/6af4..." -> "/jobs/info/*": ids and long names are not part of the pattern.
  const pattern = url => new URL(url).pathname.split('/').slice(0, 5)
    .map(p => (/\d{3,}|^[0-9a-f-]{12,}$|.{28,}/i.test(p) ? '*' : p)).join('/') || '/';
  made.sent = () => sent;
  made.kinds = (top = 25) => [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, n]) => `${k} x${n}`);
  const web = session.defaultSession.webRequest;
  const isWeb = url => /^https?:/i.test(url);
  const fromJobright = d => {
    try { return hiddenWindows.has(d.webContentsId) && /(?:^|\.)jobright\.ai$/i.test(new URL(d.url).hostname); } catch { return false; }
  };
  web.onBeforeRequest((d, done) => done({ cancel: skipped(d) }));
  web.onCompleted(d => {
    if (!isWeb(d.url)) return;
    made.count(d.url, d.fromCache ? 'cached' : d.statusCode);
    if (!d.fromCache && fromJobright(d)) {
      sent++;
      try { const k = `${d.resourceType} ${new URL(d.url).hostname}${pattern(d.url)}`; kinds.set(k, (kinds.get(k) || 0) + 1); } catch { /* not counted by kind */ }
    }
    if (d.statusCode === 429 && fromJobright(d)) {
      runlog.log(`    ${d.method || 'GET'} ${d.url} -> HTTP 429`);
      stop(halt, new StopRun('Jobright answered "too many requests" (HTTP 429)', true));
    }
  });
  web.onErrorOccurred(d => { if (isWeb(d.url)) made.count(d.url, /BLOCKED_BY_CLIENT/.test(d.error) ? 'skipped' : 'failed'); });
  return Object.assign(() => {
    web.onBeforeRequest(null);
    web.onCompleted(null);
    web.onErrorOccurred(null);
    return made;
  }, { made });
}

// Titles that are really HTTP/server error pages, not jobs. A gateway error
// (502/503/504) returns an HTML page whose <h1> is the error text, which must
// never be ingested as a role. Used as a belt-and-suspenders guard alongside
// the HTTP status check.
const HTTP_ERR_TITLE = /^\s*(?:\d{3}\s+)?(?:bad gateway|service (?:temporarily )?unavailable|gateway time-?out|internal server error|too many requests|forbidden|not found|service unavailable|request timeout|origin (?:error|is unreachable)|web server is (?:down|returning an unknown error)|access denied|are you a robot|just a moment|attention required)\s*$|^\s*(?:error\s+)?(?:50[0-9]|40[0-9]|429|52[0-9])\b/i;

/** Poll until querySelector succeeds or timeout. */
async function waitSelector(win, selector, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await win.webContents.executeJavaScript(
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (found) return true;
    await sleep(250);
  }
  return false;
}

async function js(win, code) {
  return win.webContents.executeJavaScript(code);
}

// A reason to request nothing more from Jobright in this run. refused: Jobright
// turned a request away (HTTP 403 or 429), as opposed to the session ending.
class StopRun extends Error {
  constructor(message, refused = false) { super(message); this.refused = refused; }
}
const REFUSED = new Set([403, 429]);
const stop = (halt, why) => {
  if (!halt.reason) halt.reason = why.message;
  halt.refused = halt.refused || !!why.refused;
};

const atLogin = win => {
  try { return /login/i.test(new URL(win.webContents.getURL()).pathname); } catch { return false; }
};

/**
 * Loads a URL and returns its HTTP status. loadURL resolves on did-finish-load
 * and rejects on did-fail-load, but does NOT reject on an HTTP 4xx/5xx
 * response: an error page loads "successfully" with the error HTML as its
 * body, so the status is read from did-navigate. Throws StopRun when Jobright
 * refuses the page or sends it to the sign-in page, and an Error("timeout")
 * when the page has not loaded in LOAD_TIMEOUT_MS.
 */
const LOAD_TIMEOUT_MS = 45000;
async function loadPage(win, url) {
  let status = 0;
  let timer = null;
  const began = Date.now();
  const onNav = (_e, _url, code) => { if (typeof code === 'number') status = code; };
  win.webContents.on('did-navigate', onNav);
  try {
    const load = win.loadURL(url);
    load.catch(() => {});   // after a timeout, its own failure has nowhere to go
    await Promise.race([load, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS); })]);
  } catch (err) {
    if (err.message === 'timeout') { try { win.webContents.stop(); } catch { /* window already gone */ } }
    runlog.log(`    GET ${url} -> failed: ${err.message} (${Date.now() - began} ms)`);
    throw err;
  } finally {
    clearTimeout(timer);
    win.webContents.removeListener('did-navigate', onNav);
  }
  runlog.log(`    GET ${url} -> HTTP ${status || '?'} (${Date.now() - began} ms)${atLogin(win) ? ', sent to the sign-in page' : ''}`);
  if (REFUSED.has(status)) throw new StopRun(`Jobright refused a page (HTTP ${status})`, true);
  if (status === 401 || atLogin(win)) throw new StopRun('the Jobright session expired - please sign in again');
  return status;
}

// ── URL construction ──────────────────────────────────────────────────────────

const SEARCH_URL = 'https://jobright.ai/jobs/search';
const WORK_MODEL = { Onsite: 1, Remote: 2, Hybrid: 3 };
// JobSift's employment types as Jobright's job types. Jobright has no
// temporary type, so a track accepting temporary roles leaves job type open.
const JOB_TYPE = { 'Full-time': 1, Contract: 2, 'Contract to hire': 2, 'Part-time': 3, Internship: 4 };
// The posting ages Jobright offers, in days. A run's range is searched with the
// shortest one that covers it.
const JOBRIGHT_DAYS = [1, 3, 7, 30];
const jobrightDays = days => JOBRIGHT_DAYS.find(d => d >= days) ?? JOBRIGHT_DAYS[JOBRIGHT_DAYS.length - 1];

/**
 * Jobright's own filters for what every track rejects anyway (searchPlan's
 * jobrightFilters), as search parameters. Experience levels are numbered in
 * Jobright's order, from 1. Industries go as written: a name that is not one
 * of Jobright's industries leaves nothing out.
 */
function filterParams(f) {
  const set = { isH1BOnly: 'false', excludeStaffingAgency: 'false', excludeUsCitizen: 'false',
                excludeSecurityClearance: String(f.noClearance) };
  const types = f.employmentTypes?.map(t => JOB_TYPE[t]);
  if (types && types.every(Boolean)) set.jobTypes = [...new Set(types)].sort().join(',');
  if (f.experienceLevels) set.seniority = f.experienceLevels.map(l => EXPERIENCE_LEVELS.indexOf(l) + 1).join(',');
  if (f.blockedIndustries) set.excludeCompanyCategory = f.blockedIndustries.join(',');
  return set;
}

/**
 * The Jobright searches for a run: one for each title in
 * jobright.search_titles, around every location set on an onsite or hybrid
 * track, for the arrangements the tracks accept. Jobright applies a location's
 * radius to onsite and hybrid roles only, so remote roles still come from
 * across the country; with no location set, only remote roles are searched.
 * Each search carries Jobright's filters for what every track rejects anyway.
 * The order of results does not matter: every card down to the match
 * threshold is read.
 */
function buildSearches(cfg, daysAgo) {
  const plan = searchPlan(cfg);
  const filters = filterParams(plan.jobrightFilters);
  const near = plan.areas.map(a => `${a.location} ${a.radius}mi`);
  const workTypes = [...plan.areas.flatMap(a => a.workTypes), ...(plan.remote ? ['Remote'] : [])];
  const place = !plan.areas.length
    ? (plan.remote ? { id: 'remote', set: { workModel: String(WORK_MODEL.Remote) } } : null)
    : {
        id: [...(plan.remote ? ['remote'] : []), ...near].join(' + '),
        set: {
          locations: JSON.stringify(plan.areas.map(a => ({ type: 'city', city: a.location, radiusRange: a.radius }))),
          workModel: [...new Set(workTypes.map(w => WORK_MODEL[w]))].sort().join(','),
        },
      };
  const searches = [];
  if (place) {
    for (const title of plan.jobright) {
      const q = new URLSearchParams(filters);
      q.set('value', title);
      q.set('searchType', 'job_title');
      q.set('jobTaxonomyList', JSON.stringify([{ taxonomyId: '00-00-00', title }]));
      q.set('country', COUNTRY.code);
      for (const [k, v] of Object.entries(place.set)) q.set(k, v);
      q.set('daysAgo', String(jobrightDays(daysAgo)));
      searches.push({ id: `${title} @ ${place.id}`, label: `${title} (${place.id})`, url: `${SEARCH_URL}?${q}`, maxDays: daysAgo });
    }
  }
  return searches;
}

// ── Judging cards ─────────────────────────────────────────────────────────────

/**
 * The cards every track rejects on what the card shows (eval.js, cardOnly),
 * as records ready for eval.js: listed as rejected with the reason, never
 * opened. The Jobright page stands in for the apply link, so later runs skip
 * the role like any role already shown.
 */
async function screenCards(cards, cfg) {
  const records = cards.map(c => {
    const f = cardFields(c.card_text) || {};
    return {
      jid: c.jid, url: c.url, match_pct: c.match_pct, card_text: c.card_text,
      company: f.company || null, title: f.title || null, location: f.location || null,
      work_type: f.work_type || null, salary: f.salary || null,
    };
  });
  const why = await evalEngine.run({ results: records }, cfg, { cardOnly: true });
  return records.filter(r => why.has(r.jid)).map(r => ({ ...r, ats_url: r.url, error: null, avoided: why.get(r.jid) }));
}

// Whether two cards of one posting show the same title, company, and pay. A
// posting whose card differs from the one it was read under is read again.
function sameCard(a, b) {
  const x = cardFields(a), y = cardFields(b);
  return !x || !y || ['title', 'company', 'salary'].every(k => x[k] === y[k]);
}

// ── Popup dismissal ───────────────────────────────────────────────────────────

/**
 * Dismiss Ant Design modal overlays. Loops up to 3 times, waits 3s each.
 */
async function dismissPopups(win) {
  for (let i = 0; i < 3; i++) {
    const found = await waitSelector(win, 'button.ant-modal-close', 3000);
    if (!found) break;
    try {
      await js(win, `document.querySelector('button.ant-modal-close')?.click()`);
      await sleep(400);
    } catch { break; }
  }
}

// ── Listing collection (scroll loop) ─────────────────────────────────────────

/**
 * Scroll the results panel, harvest job IDs, match scores, and card text.
 * Returns the cards at or above the match threshold not seen in this run.
 * Each card is read once: a card that has been read is marked on the page,
 * and each pass reads only the unmarked ones.
 */
async function collectListingUrls(win, minPct, seen, scrollPauseMs, { signal, passControl, halt }) {
  const results = [];
  const here = new Set();  // the cards this search has loaded, including ones an earlier search found
  let stall = 0;  // consecutive scroll passes that loaded no new cards (end guard)

  while (true) {
    if (signal?.aborted || passControl?.abort || halt.reason) break;

    const cards = await js(win, `
      (function() {
        const cards = [...document.querySelectorAll(${JSON.stringify(SEL_CARD + ':not([data-jobsift-read])')})];
        const out = [];
        for (const card of cards) {
          const link = card.querySelector(${JSON.stringify(SEL_LINK)});
          const href = link ? link.getAttribute('href') : '';
          const jid  = href ? href.split('?')[0].split('#')[0].replace(/\\/$/, '').split('/').pop() : '';
          if (!jid) continue;
          card.setAttribute('data-jobsift-read', '');
          const scoreEl = card.querySelector(${JSON.stringify(SEL_SCORE)});
          const pctRaw  = scoreEl ? scoreEl.innerText.trim() : '';
          const pct     = /^\\d+$/.test(pctRaw) ? parseInt(pctRaw, 10) : null;
          out.push({ jid, pct, text: card.innerText.slice(0, 600) });
        }
        return out;
      })()
    `);

    // Any card this search loaded for the first time this pass (including ones
    // below the threshold or found by an earlier search): what tells the end
    // of the results from a page still loading.
    let newSeenThisPass = 0;
    for (const card of cards) {
      const { jid, pct, text } = card;
      if (!here.has(jid)) { here.add(jid); newSeenThisPass++; }
      if (seen.has(jid)) continue;
      seen.add(jid);

      // Skip listings below the configured match threshold, but keep scanning.
      // We do NOT stop early: every listing at or above min_match_pct in the
      // selected window is collected (filtering happens later in eval).
      if (pct !== null && pct < minPct) continue;

      results.push({
        jid,
        url:       `https://jobright.ai/jobs/info/${jid}`,
        match_pct: pct,
        card_text: text,
      });
    }

    // Scroll the job list container, not the window: Jobright renders results
    // in an inner scroll pane and the page body itself does not move.
    const [prevH] = await js(win, `
      (function() {
        const card = document.querySelector(${JSON.stringify(SEL_CARD)});
        let el = card;
        while (el) {
          const ov = window.getComputedStyle(el).overflowY;
          if (ov === 'auto' || ov === 'scroll') {
            const prev = el.scrollHeight;
            el.scrollTop = el.scrollHeight;
            return [prev];
          }
          el = el.parentElement;
        }
        const prev = document.documentElement.scrollHeight;
        window.scrollTo(0, prev);
        return [prev];
      })()
    `);

    await sleep(scrollPauseMs * (1 + Math.random() * 0.3));

    const newH = await js(win, `
      (function() {
        const card = document.querySelector(${JSON.stringify(SEL_CARD)});
        let el = card;
        while (el) {
          const ov = window.getComputedStyle(el).overflowY;
          if (ov === 'auto' || ov === 'scroll') return el.scrollHeight;
          el = el.parentElement;
        }
        return document.documentElement.scrollHeight;
      })()
    `);

    // End of results: stop when the list no longer grows and nothing new loaded,
    // or after several consecutive passes that loaded no new cards (guards against
    // a container height that keeps jittering at the end of a long list).
    stall = newSeenThisPass === 0 ? stall + 1 : 0;
    if ((newH === prevH && newSeenThisPass === 0) || stall >= 4) {
      console.log(`    End of results - ${results.length} cards at or above ${minPct}% match`);
      return results;
    }
  }

  return results;
}

// ── Detail extraction ─────────────────────────────────────────────────────────

/**
 * Navigate to a listing page and extract structured fields.
 */
async function extractDetail(win, item) {
  const empty = {
    company: null, title: null, location: null,
    work_type: null, salary: null,
    responsibilities: null, required_quals: null, preferred_quals: null,
    body_text: null, ats_url: null, error: null, is_closed: false,
  };
  const record = { ...item, ...empty };

  // Retry once, after a pause, so a transient page-load timeout or server
  // error re-attempts the page instead of dropping the listing. A page Jobright
  // refuses is not retried: it ends the run's requests (StopRun).
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
   try {
    // An error status is a failed load, never parsed as a job titled
    // "502 Bad Gateway"; a posting that no longer exists is closed.
    const httpStatus = await loadPage(win, item.url);
    if (httpStatus === 404 || httpStatus === 410) {
      record.is_closed = true;
      record.error = 'CLOSED';
      return record;
    }
    if (httpStatus >= 400) throw new Error(`HTTP ${httpStatus}`);
    const h1Found = await waitSelector(win, 'h1', 12000);
    if (!h1Found) {
      if (atLogin(win)) throw new StopRun('the Jobright session expired - please sign in again');
      throw new Error('h1 not found');
    }
    await sleep(300);

    const extracted = await js(win, `
      (function() {
        const compEl = document.querySelector('h2[class*="company-row"]');
        const company = compEl ? compEl.innerText.split('\\n')[0].trim() : null;
        const title   = document.querySelector('h1')?.innerText?.trim() || null;

        const metaItems = [...document.querySelectorAll('[class*="job-metadata-item"]')]
          .map(el => el.innerText.trim());

        const location = metaItems.find(t =>
          !/remote|hybrid|onsite|on-site|in-person|full.time|part.time|level|\\$|exp/i.test(t)
          && t.length > 1) || null;

        const workTypeBadge = metaItems.find(t =>
          /^(remote|hybrid|on.?site|in.person)$/i.test(t)) || null;

        const workType = workTypeBadge || (
          location && !/^(remote|united states|\\bus\\b|anywhere|worldwide|usa)/i.test(location)
          ? 'Onsite' : null
        );

        const salary = metaItems.find(t => /\\$/.test(t)) || null;

        function getLabelSection(headingText) {
          const h2 = [...document.querySelectorAll('h2[class*="index_label"]')]
            .find(h => h.innerText.trim() === headingText);
          if (!h2) return null;
          return h2.parentElement?.nextElementSibling?.innerText?.trim() || null;
        }

        function getQualSection(headingText) {
          const h4 = [...document.querySelectorAll('h4[class*="qualifications-sub-title"]')]
            .find(h => h.innerText.trim() === headingText);
          if (!h4) return null;
          const parts = [];
          let el = h4.nextElementSibling;
          while (el) {
            if (['H4', 'H2'].includes(el.tagName)) break;
            const t = el.innerText?.trim();
            if (t) parts.push(t);
            el = el.nextElementSibling;
          }
          return parts.join('\\n') || null;
        }

        const responsibilities = getLabelSection('Responsibilities');
        const required_quals   = getQualSection('Required');
        const preferred_quals  = getQualSection('Preferred');

        const atsLink = [...document.querySelectorAll('a')]
          .find(a => a.textContent.includes('Original Job Post'));
        const ats_url = atsLink ? atsLink.getAttribute('href') : null;

        const _firstH2 = document.querySelector('h2[class*="index_label"]');
        const _bodyContainer = _firstH2
          ? (_firstH2.parentElement?.parentElement || _firstH2.parentElement)
          : (document.querySelector('article') || document.querySelector('main'));
        const body_text = _bodyContainer
          ? _bodyContainer.innerText.slice(0, 8000) : '';

        const is_closed = /no longer accepting applications/i.test(
          document.body?.innerText?.slice(0, 1500) || ''
        );

        return {
          company, title, location, work_type: workType, salary,
          responsibilities: responsibilities ? responsibilities.slice(0, 2000) : null,
          required_quals:   required_quals   ? required_quals.slice(0, 1500)   : null,
          preferred_quals:  preferred_quals  ? preferred_quals.slice(0, 1500)  : null,
          body_text: body_text || null,
          ats_url,
          is_closed,
        };
      })()
    `);

    // Belt-and-suspenders: even if the status check passed (or the proxy served
    // an error body with a 200), reject a title that is clearly an HTTP error page.
    if (extracted.title && HTTP_ERR_TITLE.test(extracted.title)) {
      throw new Error(`error-page title: ${extracted.title.slice(0, 40)}`);
    }

    Object.assign(record, extracted);
    record.error = null;  // succeeded; clear any error from a prior attempt

    if (record.is_closed) {
      record.error = 'CLOSED';
      return record;
    }

    // Salary fallback - scan body text
    if (!record.salary) {
      const body = [record.body_text, record.responsibilities, record.required_quals, record.preferred_quals]
        .filter(Boolean).join(' ');
      const m = /\$\d[\d,\-]+(?:\s*[-–—]\s*\$?\d[\d,\-]+)?/.exec(body);
      if (m) record.salary = m[0];
    }

    return record;  // success

   } catch (err) {
    if (err instanceof StopRun) throw err;
    record.error = err.message;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_PAUSE_MS);
   }
  }

  return record;
}

// ── Worker pool ───────────────────────────────────────────────────────────────

// The pause before each posting: DETAIL_PAUSE_MS, plus up to as much again.
// It doubles with each posting that fails to load, up to MAX_DETAIL_PAUSE_MS,
// and eases back a quarter with each one that loads.
const DETAIL_PAUSE_MS     = 1000;
const MAX_DETAIL_PAUSE_MS = 30000;
const RETRY_PAUSE_MS      = 3000;
// The rest between one search and the next, plus up to as much again.
const BETWEEN_PASSES_MS   = 3000;
// Postings failing to load this many times in a row means Jobright is not
// answering; the rest are left for a later run.
const MAX_FAILS_IN_A_ROW = 5;

// A record that failed to enrich: an error with no usable title or body.
const unusable = r => !!r.error && !r.is_closed && !r.title && !r.body_text && !r.responsibilities;

/**
 * Process detail pages using a pool of N hidden BrowserWindows, each pausing
 * between pages (see DETAIL_PAUSE_MS).
 * N comes from config.settings.detail_workers, at most MAX_DETAIL_WORKERS.
 * Returns { read, closed }: the postings read, and a short record for each
 * found closed. onRead is given each of both as it is read. Sets halt
 * and stops when Jobright refuses a page, the session ends, or postings stop
 * loading.
 */
async function fetchDetailsPool(listings, nWorkers, { signal, passControl, halt, onRead }, onTick) {
  const workers = Array.from({ length: Math.min(nWorkers, listings.length) }, makeHiddenWindow);
  const results = new Array(listings.length);
  let nextIdx = 0;
  let done = 0, failsInARow = 0, pause = DETAIL_PAUSE_MS;

  async function workerLoop(win) {
    try {
      while (true) {
        if (signal?.aborted || passControl?.abort || halt.reason) break;
        const idx = nextIdx++;
        if (idx >= listings.length) break;
        if (idx >= nWorkers) await sleep(pause * (1 + Math.random()));
        try {
          const full = await extractDetail(win, listings[idx]);
          const detail = full.is_closed ? { jid: full.jid, url: full.url, is_closed: true, error: 'CLOSED' } : full;
          detail.search_pass = listings[idx].search_pass;
          results[idx] = detail;
          done++;
          if (onTick) onTick(done, listings.length, detail);
          runlog.log(`    posting ${detail.jid}: ${detail.is_closed ? 'closed' : unusable(detail) ? `failed (${detail.error})` : detail.error ? `read, with ${detail.error}` : 'read'}`);
          failsInARow = unusable(detail) ? failsInARow + 1 : 0;
          const slower = unusable(detail) ? Math.min(pause * 2, MAX_DETAIL_PAUSE_MS) : Math.max(DETAIL_PAUSE_MS, pause * 0.75);
          if (slower > pause) runlog.log(`    pausing ${Math.round(slower / 1000)}s or more between postings`);
          pause = slower;
          if (failsInARow >= MAX_FAILS_IN_A_ROW) stop(halt, new StopRun('Jobright postings stopped loading'));
          if (!unusable(detail) && onRead) onRead(detail);
        } catch (err) {
          if (err instanceof StopRun) { stop(halt, err); break; }
          // Record as error rather than crashing the whole pool
          console.error(`    Worker error on ${listings[idx].jid}: ${err.message}`);
          done++;
        }
      }
    } finally {
      // Always destroy the window, even if an unexpected error escapes the inner try
      if (!win.isDestroyed()) win.destroy();
    }
  }

  await Promise.all(workers.map(workerLoop));
  const got = results.filter(Boolean);
  const closed = got.filter(r => r.is_closed);
  if (closed.length) console.log(`\n    ${closed.length} closed listing(s) skipped`);
  // Leave out any record that failed to enrich. This prevents error-page
  // artifacts and empty-content shells from flowing into the merge/eval as
  // phantom roles.
  const read = got.filter(r => !r.is_closed && !unusable(r));
  const dropped = got.length - closed.length - read.length;
  if (dropped) console.log(`\n    ${dropped} listing(s) dropped (failed to load/enrich)`);
  return { read, closed };
}

// ── One search pass ───────────────────────────────────────────────────────────

/**
 * Runs one search and returns its records: the postings read, those reused
 * from an earlier run, the cards rejected without being opened, and a short
 * record for each closed posting. ctx is the run's shared state (see run).
 * onProgress(text, share) is given what the pass is doing and how far it is.
 */
async function runSearch(searchCfg, ctx, onProgress) {
  const { cfg, known, closed, shown, minPct, scrollPause, nWorkers, seen, signal, passControl, halt, sentSoFar } = ctx;
  const sentAtStart = sentSoFar();
  console.log(`\n  ${'='.repeat(56)}`);
  console.log(`  Pass: ${searchCfg.label}`);
  console.log(`  URL:  ${searchCfg.url}`);
  console.log(`  ${'='.repeat(56)}`);

  const win = makeHiddenWindow();

  try {
    const status = await loadPage(win, searchCfg.url);
    if (status >= 400) throw new Error(`HTTP ${status}`);
    await sleep(2500);

    // The sign-in page can also take over after the search page has loaded.
    if (atLogin(win)) throw new StopRun('the Jobright session expired - please sign in again');

    await dismissPopups(win);

    console.log(`    Collecting listings >= ${minPct}% match...`);
    onProgress('collecting listings', 0);
    const found = await collectListingUrls(win, minPct, seen, scrollPause, ctx);
    win.destroy();
    const sentSearching = sentSoFar() - sentAtStart;
    runlog.log(`    the search and its scrolling: ${sentSearching} requests answered by Jobright`);
    // Stopped mid-search: the cards are not all there, so none are judged.
    if (halt.reason) return [];
    // A range Jobright does not offer is searched with a longer one; cards
    // posted before the run's own range are left out.
    const inRange = found.filter(c => !(evalEngine.daysFromCard(c.card_text.split('\n')[0]) > searchCfg.maxDays));
    if (inRange.length < found.length) console.log(`    ${found.length - inRange.length} cards posted more than ${searchCfg.maxDays} days ago left out`);
    // Roles an earlier run already showed are not looked at again.
    const cards = inRange.filter(c => !shown.has(c.jid));
    if (cards.length < inRange.length) console.log(`    ${inRange.length - cards.length} cards already shown by an earlier run left out`);

    // If the pass was skipped during collection, roll over with nothing.
    if (signal?.aborted || passControl?.abort) return [];

    // Judge each card first, then set aside the postings an earlier run found
    // closed and reuse those it read; only the rest are opened.
    const avoided = await screenCards(cards, cfg);
    const rejected = new Set(avoided.map(r => r.jid));
    const reused = [], gone = [], listings = [];
    for (const c of cards) {
      if (rejected.has(c.jid)) continue;
      const prior = known.get(c.jid);
      if (closed.has(c.jid)) gone.push({ jid: c.jid, url: c.url, is_closed: true, error: 'CLOSED' });
      else if (prior && sameCard(prior.card_text, c.card_text)) reused.push({ ...prior, match_pct: c.match_pct, card_text: c.card_text });
      else listings.push(c);
    }
    for (const l of [...listings, ...reused, ...avoided, ...gone]) l.search_pass = searchCfg.id;
    const summary = `${cards.length} cards - ${avoided.length} rejected from the card, ${reused.length} read in an earlier run, ` +
                    `${gone.length} closed, ${listings.length} to open`;
    console.log(`    ${summary}`);
    onProgress(summary, listings.length ? 0 : 1);
    if (!listings.length) return [...reused, ...avoided, ...gone];

    console.log(`    Opening ${listings.length} postings, ${nWorkers} at a time...`);
    const opened = await fetchDetailsPool(listings, nWorkers, ctx, (done, tot, detail) => {
      process.stdout.write(`\r    [${String(done).padStart(3)}/${tot}] ${detail.jid}  `);
      onProgress(`opening postings, ${done}/${tot}`, done / tot);
    });
    console.log(`\n    ${opened.read.length} records extracted`);
    runlog.log(`    opening ${listings.length} postings: ${sentSoFar() - sentAtStart - sentSearching} requests answered by Jobright`);
    onProgress(`${summary.replace(/ to open$/, ' opened')}${opened.closed.length ? `, ${opened.closed.length} of them closed` : ''}`, 1);
    return [...opened.read, ...reused, ...avoided, ...gone, ...opened.closed];
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * run({ cfg, daysAgo, known, closed, shown, signal, onProgress, onRead })
 *   -> { records, complete, refused, requests }
 *   known                       postings read in earlier runs, by jid; not opened again
 *   closed                      jids of postings earlier runs found closed; not opened again
 *   shown                       jids of roles earlier runs already showed; left out
 *   onProgress(message, share, line)  share is how far the run is, 0 to 1;
 *                               messages with the same line replace one another
 *                               in the activity feed, so each pass shows as one line
 *   onRead(record)              called with each posting as it is read
 *   records    the job records, with a short record ({ jid, is_closed: true })
 *              for each closed posting, which is kept on file but is not a role
 *   complete   whether every search ran to its end, so the whole period was covered
 *   refused    whether Jobright turned a request away (HTTP 403 or 429)
 *   requests   every web request made during the run, by site and status (a runlog.tally)
 */
async function run({ cfg, daysAgo = 7, known = new Map(), closed = new Set(), shown = new Set(), signal, onProgress, onRead = null, passControl = null }) {
  const emit = (msg, pct, line) => { if (onProgress) onProgress(msg, pct, line); };

  const settings      = cfg.settings       || {};
  const minPct        = settings.min_match_pct  ?? 60;
  const scrollPause   = Math.max(MIN_SCROLL_PAUSE_MS, settings.scroll_pause_ms ?? 1800);
  const nWorkers      = Math.min(MAX_DETAIL_WORKERS, Math.max(1, settings.detail_workers ?? MAX_DETAIL_WORKERS));

  const searches = buildSearches(cfg, daysAgo);
  if (!searches.length) {
    console.log(cfg.jobright?.search_titles?.length
      ? '\nJobright Scraper - no searches: no track accepts remote work or has a location'
      : '\nJobright Scraper - no searches: add search titles for Jobright on the Sources tab');
    return { records: [], complete: false, refused: false, requests: runlog.tally() };
  }
  console.log(`\nJobright Scraper - ${searches.length} pass(es): ${searches.map(s => s.id).join(', ')}`);

  const halt = { reason: null, refused: false };  // set when nothing more is to be requested from Jobright
  const stopWatching = watchRequests(halt);
  const sentSoFar = () => stopWatching.made.sent();
  const ctx = { sentSoFar, cfg, known, closed, shown, minPct, scrollPause, nWorkers, seen: new Set(), signal, passControl, halt, onRead };
  const allResults = [];
  let complete = true;
  let passIdx = 0;

  for (const search of searches) {
    if (signal?.aborted) break;
    if (passIdx > 0) await sleep(BETWEEN_PASSES_MS * (1 + Math.random()));
    if (passControl) passControl.abort = false;  // reset the per-pass skip flag
    // Everything a pass reports is one line of the activity feed.
    const say = (text, share) => emit(`Pass ${search.label}: ${text}`, (passIdx + share) / searches.length, `pass:${search.id}`);
    say('loading the search', 0);
    // Isolate each pass: a failure (e.g. a search-page load timeout) on one
    // pass should not lose the listings already gathered by other passes.
    try {
      const results = await runSearch(search, ctx, say);
      allResults.push(...results);
      if (passControl?.abort) {
        complete = false;
        say('skipped by user; continuing', 1);
      }
    } catch (err) {
      complete = false;
      if (err instanceof StopRun) stop(halt, err);
      else {
        console.error(`  Pass "${search.label}" failed: ${err.message}`);
        say(`failed (${err.message}); continuing`, 1);
      }
    }
    if (halt.reason) {
      complete = false;
      console.error(`  Jobright stopped: ${halt.reason}`);
      emit(`Jobright stopped: ${halt.reason}. What is left is picked up by the next run.`, (passIdx + 1) / searches.length);
      break;
    }
    passIdx++;
  }
  const requests = stopWatching();
  if (signal?.aborted) complete = false;

  // A posting found by more than one search is kept once.
  const seenJids = new Set();
  const deduped  = [];
  for (const r of allResults) {
    if (!seenJids.has(r.jid)) { seenJids.add(r.jid); deduped.push(r); }
  }

  console.log(`\n  Jobright done - ${deduped.length} records`);
  return { records: deduped, complete, refused: halt.refused, requests };
}

module.exports = { run };
