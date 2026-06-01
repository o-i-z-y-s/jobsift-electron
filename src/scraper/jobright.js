'use strict';

/**
 * src/scraper/jobright.js
 * Port of jobright_scraper.py — uses Electron hidden BrowserWindows +
 * webContents.executeJavaScript() instead of Playwright.
 * Session is inherited from session.defaultSession (already authenticated).
 */

const { BrowserWindow } = require('electron');

// ── Selectors (verified against live Jobright DOM 2026-04-29) ─────────────────
const SEL_CARD      = '[class*="job-card"]';
const SEL_LINK      = 'a[href*="/jobs/info/"]';
const SEL_SCORE     = '[class*="job-display-score"] [class*="percent-value"]';
const SEL_SORT_BTN  = '[class*="recommend-sorter"] .ant-select-selector';
const SEL_SORT_OPTS = '[class*="ant-select-item-option"]';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeHiddenWindow() {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,   // allows executeJavaScript freely
      nodeIntegration:  false,
      sandbox:          false,   // must be false for executeJavaScript to work reliably
    },
  });
}

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

// ── URL construction ──────────────────────────────────────────────────────────

const BASE =
  'https://jobright.ai/jobs/search' +
  '?searchType=job_title' +
  '&country=US' +
  '&isH1BOnly=false' +
  '&excludeStaffingAgency=false' +
  '&excludeSecurityClearance=false' +
  '&excludeUsCitizen=false' +
  '&refresh=true&position=0&sortCondition=0';

function taxonomyUrl(title) {
  const tj = JSON.stringify([{ taxonomyId: '00-00-00', title }]);
  return `&value=${encodeURIComponent(title)}&jobTaxonomyList=${encodeURIComponent(tj)}`;
}

/**
 * Construct search passes from config.json → jobright_searches.passes.
 * Mirrors build_searches() in jobright_scraper.py.
 */
function buildSearches(cfg, daysAgo) {
  const passes = (cfg.jobright_searches?.passes) || [];
  const tracks = cfg.tracks || [];

  // Find the first onsite/hybrid track with a target_location (for the local IRL pass)
  const irlTrack = tracks.find(t =>
    t.target_location &&
    (t.work_types || []).some(w => ['Onsite', 'Hybrid'].includes(w)),
  );

  const localIrlParam = irlTrack?.target_location
    ? '&locations=' + encodeURIComponent(JSON.stringify([{
        city:        irlTrack.target_location,
        radiusRange: irlTrack.target_radius_mi ?? 35,
      }]))
    : null;

  const d = `&daysAgo=${daysAgo}`;
  const searches = [];

  for (const p of passes) {
    const workModel = p.work_model || 'remote';
    if (workModel === 'local') {
      if (!localIrlParam) continue;   // no local track configured
      const locLabel = irlTrack.target_location +
        (irlTrack.target_radius_mi ? ` ${irlTrack.target_radius_mi}mi` : '');
      searches.push({
        id:    p.id,
        label: (p.label || '').replace('{location}', locLabel),
        url:   BASE + taxonomyUrl(p.taxonomy || '') + d + localIrlParam,
      });
    } else {
      searches.push({
        id:    p.id,
        label: p.label || 'Remote',
        url:   BASE + taxonomyUrl(p.taxonomy || '') + d + '&workModel=2',
      });
    }
  }
  return searches;
}

// ── Card pre-filter ───────────────────────────────────────────────────────────

function buildCardExcludeRe(patterns) {
  if (!patterns.length) return null;
  return new RegExp(
    '\\b(' + patterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i',
  );
}

// ── Popup dismissal ───────────────────────────────────────────────────────────

/**
 * Dismiss Ant Design modal overlays. Loops up to 3 times, waits 3s each.
 * Mirrors dismiss_popups() in jobright_scraper.py.
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

// ── Sort dropdown ─────────────────────────────────────────────────────────────

async function sortTopMatched(win) {
  try {
    const btnFound = await waitSelector(win, SEL_SORT_BTN, 6000);
    if (!btnFound) return;
    await js(win, `document.querySelector(${JSON.stringify(SEL_SORT_BTN)})?.click()`);
    await sleep(700);
    const clicked = await js(win, `
      (function() {
        const opts = [...document.querySelectorAll(${JSON.stringify(SEL_SORT_OPTS)})];
        const target = opts.find(o => {
          const t = o.innerText.trim().toLowerCase();
          return t.includes('top') || t.includes('match');
        });
        if (target) { target.click(); return true; }
        return false;
      })()
    `);
    if (clicked) await sleep(1800);
  } catch (err) {
    console.log(`    Sort error: ${err.message}`);
  }
}

// ── Listing collection (scroll loop) ─────────────────────────────────────────

/**
 * Scroll the results panel, harvest job IDs + match scores.
 * Stops when MIN_MATCH_PCT is hit three consecutive times.
 * Mirrors collect_listing_urls() in jobright_scraper.py.
 */
async function collectListingUrls(win, minPct, seen, cardExcludeRe, scrollPauseMs, signal) {
  const results = [];
  let stall = 0;  // consecutive scroll passes that loaded no new cards (end guard)

  while (true) {
    if (signal?.aborted) break;

    const cards = await js(win, `
      (function() {
        const cards = [...document.querySelectorAll(${JSON.stringify(SEL_CARD)})];
        return cards.map(card => {
          const link = card.querySelector(${JSON.stringify(SEL_LINK)});
          const href = link ? link.getAttribute('href') : '';
          const jid  = href ? href.split('?')[0].split('#')[0].replace(/\\/$/, '').split('/').pop() : '';
          const scoreEl = card.querySelector(${JSON.stringify(SEL_SCORE)});
          const pctRaw  = scoreEl ? scoreEl.innerText.trim() : '';
          const pct     = /^\\d+$/.test(pctRaw) ? parseInt(pctRaw, 10) : null;
          const text    = card.innerText.slice(0, 600);
          return { jid, pct, text };
        }).filter(c => c.jid);
      })()
    `);

    let newSeenThisPass = 0;  // any newly seen card this pass (incl. below threshold)
    for (const card of cards) {
      const { jid, pct, text } = card;
      if (seen.has(jid)) continue;
      seen.add(jid);
      newSeenThisPass++;

      // Skip listings below the configured match threshold, but keep scanning.
      // We do NOT stop early: every listing at or above min_match_pct in the
      // selected window is collected (filtering happens later in eval).
      if (pct !== null && pct < minPct) continue;

      if (cardExcludeRe && cardExcludeRe.test(text)) continue;

      results.push({
        jid,
        url:       `https://jobright.ai/jobs/info/${jid}`,
        match_pct: pct,
        card_text: text,
      });
    }

    // Scroll the job list container (mirrors the Python scroll logic)
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

    await sleep(scrollPauseMs);

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
      console.log(`    End of results - ${results.length} listings collected (>= ${minPct}% match)`);
      return results;
    }
  }

  return results;
}

// ── Detail extraction ─────────────────────────────────────────────────────────

/**
 * Navigate to a listing page and extract structured fields.
 * Mirrors extract_detail() in jobright_scraper.py.
 */
async function extractDetail(win, item) {
  const empty = {
    company: null, title: null, location: null,
    work_type: null, salary: null,
    responsibilities: null, required_quals: null, preferred_quals: null,
    body_text: null, ats_url: null, error: null, is_closed: false,
  };
  const record = { ...item, ...empty };

  try {
    // loadURL resolves on did-finish-load and rejects on did-fail-load, so the
    // load is already complete here. Readiness of SPA content is handled by the
    // waitSelector poll below.
    await win.loadURL(item.url);
    const h1Found = await waitSelector(win, 'h1', 10000);
    if (!h1Found) throw new Error('h1 not found');
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

    Object.assign(record, extracted);

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

  } catch (err) {
    record.error = err.message === 'Navigation timeout' ? 'timeout' : err.message;
  }

  return record;
}

// ── Worker pool ───────────────────────────────────────────────────────────────

/**
 * Process detail pages using a pool of N hidden BrowserWindows.
 * N comes from config.settings.detail_workers (default 3).
 */
async function fetchDetailsPool(listings, nWorkers, signal, onTick) {
  const workers = Array.from({ length: nWorkers }, makeHiddenWindow);
  const results = new Array(listings.length);
  let nextIdx = 0;
  let closed = 0, done = 0;

  async function workerLoop(win) {
    try {
      while (true) {
        if (signal?.aborted) break;
        const idx = nextIdx++;
        if (idx >= listings.length) break;
        try {
          const detail = await extractDetail(win, listings[idx]);
          detail.search_pass = listings[idx].search_pass;
          results[idx] = detail;
          done++;
          if (onTick) onTick(done, listings.length, detail);
          if (detail.is_closed) closed++;
        } catch (err) {
          // Record as error rather than crashing the whole pool
          console.error(`    Worker error on ${listings[nextIdx - 1]?.jid}: ${err.message}`);
          done++;
        }
      }
    } finally {
      // Always destroy the window, even if an unexpected error escapes the inner try
      if (!win.isDestroyed()) win.destroy();
    }
  }

  await Promise.all(workers.map(workerLoop));
  if (closed) console.log(`\n    ${closed} closed listing(s) skipped`);
  return results.filter(r => r && !r.is_closed);
}

// ── One search pass ───────────────────────────────────────────────────────────

async function runSearch(searchCfg, minPct, scrollPauseMs, nWorkers, cardExcludeRe, seen, signal, onProgress) {
  console.log(`\n  ${'='.repeat(56)}`);
  console.log(`  Pass: ${searchCfg.label}`);
  console.log(`  URL:  ${searchCfg.url}`);
  console.log(`  ${'='.repeat(56)}`);

  const win = makeHiddenWindow();

  try {
    // loadURL already resolves once the page has finished loading.
    await win.loadURL(searchCfg.url);
    await sleep(2500);

    // Login guard
    const curUrl = win.webContents.getURL();
    if (curUrl.toLowerCase().includes('login')) {
      win.destroy();
      throw new Error('Jobright session expired during search - please log in again.');
    }

    await dismissPopups(win);
    await sortTopMatched(win);

    console.log(`    Collecting listings >= ${minPct}% match...`);
    const listings = await collectListingUrls(win, minPct, seen, cardExcludeRe, scrollPauseMs, signal);
    win.destroy();

    if (!listings.length || signal?.aborted) return [];

    // Tag each listing with the current search pass
    for (const l of listings) l.search_pass = searchCfg.id;

    console.log(`    ${listings.length} listings -> extracting details (${nWorkers} workers)...`);
    const total = listings.length;
    const results = await fetchDetailsPool(listings, nWorkers, signal, (done, tot, detail) => {
      process.stdout.write(`\r    [${String(done).padStart(3)}/${tot}] ${detail.jid}  `);
      if (onProgress) onProgress(`Pass ${searchCfg.label}: ${done}/${tot}`, done / tot);
    });
    console.log(`\n    ${results.length} records extracted`);
    return results;
  } catch (err) {
    if (!win.isDestroyed()) win.destroy();
    throw err;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * run({ cfg, daysAgo, signal, onProgress }) -> Array of job records
 */
async function run({ cfg, daysAgo = 7, signal, onProgress }) {
  const emit = (msg, pct) => { if (onProgress) onProgress(msg, pct); };

  const settings      = cfg.settings       || {};
  const minPct        = settings.min_match_pct  ?? 60;
  const scrollPause   = settings.scroll_pause_ms ?? 1800;
  const nWorkers      = Math.max(1, settings.detail_workers ?? 3);
  const cardExcludeRe = buildCardExcludeRe(cfg.title_filters?.card_exclude || []);

  const searches = buildSearches(cfg, daysAgo);
  console.log(`\nJobright Scraper - ${searches.length} pass(es): ${searches.map(s => s.id).join(', ')}`);

  const seen = new Set();
  const allResults = [];
  let passIdx = 0;

  for (const search of searches) {
    if (signal?.aborted) break;
    emit(`Running pass: ${search.label}`, passIdx / searches.length);
    const results = await runSearch(
      search, minPct, scrollPause, nWorkers, cardExcludeRe,
      seen, signal,
      (msg, pct) => emit(msg, (passIdx + pct) / searches.length),
    );
    allResults.push(...results);
    passIdx++;
  }

  // Dedup across passes by jid (seen set already handles this but be safe)
  const seenJids = new Set();
  const deduped  = [];
  for (const r of allResults) {
    if (!seenJids.has(r.jid)) { seenJids.add(r.jid); deduped.push(r); }
  }

  console.log(`\n  Jobright done - ${deduped.length} records`);
  return deduped;
}

module.exports = { run };
