'use strict';

/**
 * src/scraper/ats-http.js
 * Company job board scraper over plain fetch(), for the hiring systems in
 * boards.SYSTEMS: Greenhouse, Lever, Ashby, Workday, Eightfold, Oracle, Gem,
 * iCIMS career sites, Rippling, and Workable.
 * Searches the boards in the config, and the boards of the user's connections'
 * companies (see src/boards.js for how those are found).
 * Output format is identical to jobright.js so eval.js merges them cleanly.
 */

const { criteriaFromConfig, jobrightPlan, COUNTRY } = require('../criteria');
const { companyKey, companyWords } = require('../connections');
const boards = require('../boards');
const { placeChecker, stateNameOf, namesOnlyAState } = require('../eval');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Utilities ─────────────────────────────────────────────────────────────────

// A pause that ends early when the signal aborts.
function sleep(ms, signal = null) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ── Rate limits ───────────────────────────────────────────────────────────────
// A board that answers HTTP 429 (too many requests) is waited on before the
// retry: as long as its Retry-After asks, up to MAX_WAIT, and at least the
// RATE_BACKOFFS step. Its host then gets a gap before every later request in
// the run, starting at 1 second and doubling with each 429, up to MAX_GAP.
// Boards are read in parallel lanes (see run()), so a wait holds up only the
// lane of the board that asked for it.

const RATE_BACKOFFS = [5000, 10000, 20000];
const MAX_WAIT = 30000;
const MAX_GAP  = 8000;
const hostGap  = new Map();   // host -> ms between requests
const hostNext = new Map();   // host -> earliest time of its next request

const hostOfUrl = url => { try { return new URL(url).hostname; } catch { return ''; } };

function retryAfterMs(r) {
  const v = r.headers.get('retry-after');
  if (!v) return 0;
  const ms = /^\d+$/.test(v.trim()) ? Number(v) * 1000 : Date.parse(v) - Date.now();
  return ms > 0 ? Math.min(ms, MAX_WAIT) : 0;
}

async function paceHost(host, signal) {
  const gap = hostGap.get(host);
  if (!gap) return;
  const wait = (hostNext.get(host) || 0) - Date.now();
  if (wait > 0) await sleep(wait, signal);
  hostNext.set(host, Date.now() + gap);
}

function slowHost(host) {
  hostGap.set(host, Math.min(Math.max((hostGap.get(host) || 0) * 2, 1000), MAX_GAP));
}

// Why a request failed, for the run feed: the status a board kept answering
// after the retries, or the network error.
function whyFailed(err) {
  if (err.status) return `HTTP ${err.status}${err.retried ? ' after retries' : ''}`;
  return `network error - ${withCause(err).message}`;
}

// fetch() reports most network failures as "fetch failed", with the reason
// (ECONNRESET, ENOTFOUND, a certificate error ...) only in its cause.
function withCause(err) {
  const why = err?.cause?.code || err?.cause?.message;
  if (why && !String(err.message).includes(why)) err.message = `${err.message} (${why})`;
  return err;
}

async function fetchRetry(url, opts = {}, retries = 3, abortSignal = null) {
  const backoffs = [500, 1000, 2000];
  const retryOn  = new Set([429, 500, 502, 503, 504]);
  const host = hostOfUrl(url);
  for (let i = 0; i <= retries; i++) {
    await paceHost(host, abortSignal);
    // Combine per-request timeout with caller's cancellation signal so that
    // Cancel Scrape immediately stops in-flight HTTP requests.
    const timeoutSig = AbortSignal.timeout(15000);
    const signal = abortSignal
      ? AbortSignal.any([timeoutSig, abortSignal])
      : timeoutSig;
    try {
      // Headers a caller passes replace the default browser name. Workday
      // answers a job search that claims to come from a browser with a web
      // page instead of data, so the Workday and Ashby requests, which pass
      // their own headers, go out without it.
      const r = await fetch(url, {
        ...opts,
        headers: opts.headers || { 'User-Agent': USER_AGENT },
        signal,
      });
      if (retryOn.has(r.status)) {
        if (r.status === 429) slowHost(host);
        if (i < retries) {
          const wait = r.status === 429
            ? Math.max(retryAfterMs(r), RATE_BACKOFFS[i] || MAX_WAIT)
            : backoffs[i] || 2000;
          if (r.status === 429) console.log(`  ${host} asked to slow down; waiting ${Math.round(wait / 1000)}s`);
          await sleep(wait, abortSignal);
          if (abortSignal?.aborted) throw new Error('Canceled');
          continue;
        }
        // Retries exhausted on a 5xx/429: throw rather than hand back an error
        // response, so callers treat it as a failed fetch instead of parsing the
        // gateway-error body as job content.
        throw Object.assign(new Error(`HTTP ${r.status} after ${retries} retries: ${url}`), { status: r.status, retried: true });
      }
      return r;
    } catch (err) {
      // Don't retry if the user explicitly canceled
      if (abortSignal?.aborted || i === retries) throw withCause(err);
      await sleep(backoffs[i] || 2000, abortSignal);
    }
  }
}

// ── HTML stripping ────────────────────────────────────────────────────────────

function unescapeHtml(s) {
  // Two passes: some boards emit double-encoded entities (&amp;lt; for <).
  const pass = (t) => t
    .replace(/&nbsp;/g,   ' ')
    .replace(/&amp;/g,    '&')
    .replace(/&lt;/g,     '<')
    .replace(/&gt;/g,     '>')
    .replace(/&quot;/g,   '"')
    .replace(/&#39;/g,    "'")
    .replace(/&mdash;/g,  '-')
    .replace(/&ndash;/g,  '-')
    .replace(/&apos;/g,   "'")
    .replace(/&#(\d+);/g,    (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return pass(pass(s));
}

function stripHtml(h) {
  if (!h) return '';
  let s = unescapeHtml(h);
  s = s.replace(/<[^>]+>/g, '\n');
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.join('\n');
}

// ── Salary extraction ─────────────────────────────────────────────────────────

// SAL_RE: no /g flag: only ever used with .exec() (single match per call).
// A global flag on a module-level regex makes .exec() stateful across calls.
const SAL_RE   = /\$[\d,]+(?:\.\d+)?[KkMm]?(?:\s*[-–—]\s*\$[\d,]+(?:\.\d+)?[KkMm]?)?(?:\s*\/\s*(?:yr|year|hour|hr))?/i;
// DOLLAR_RE: /gi required: used with String.matchAll() which needs the global flag.
const DOLLAR_RE = /\$[\d,]+(?:\.\d+)?[KkMm]?/gi;

function parseDollar(token) {
  let s = token.replace(/^\$/, '');
  let mult = 1;
  if (/[Kk]$/.test(s)) { mult = 1000;    s = s.slice(0, -1); }
  if (/[Mm]$/.test(s)) { mult = 1000000; s = s.slice(0, -1); }
  const v = parseFloat(s.replace(/,/g, ''));
  return isNaN(v) ? null : v * mult;
}

function collectAmounts(text) {
  const found = new Set();
  for (const m of (text.matchAll(DOLLAR_RE) || [])) {
    const n = parseDollar(m[0]);
    if (n !== null && n >= 10000) found.add(Math.round(n));
  }
  return [...found].sort((a, b) => a - b);
}

function amountsToSalary(amounts) {
  if (amounts.length >= 2) return `$${amounts[0].toLocaleString()} - $${amounts[amounts.length - 1].toLocaleString()}`;
  if (amounts.length === 1) return `$${amounts[0].toLocaleString()}`;
  return '';
}

function extractSalary(text) {
  if (!text) return '';
  const m = SAL_RE.exec(text);
  return m ? m[0] : '';
}

// Greenhouse-specific salary: sweeps metadata then content text
function ghSalary(metaList, contentText) {
  const amounts = [];

  for (const meta of (metaList || [])) {
    const raw = meta?.value;
    if (raw == null) continue;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const lo = raw.min_value ?? raw.min ?? raw.low  ?? raw.from  ?? raw.lower ?? null;
      const hi = raw.max_value ?? raw.max ?? raw.high ?? raw.to    ?? raw.upper ?? null;
      if (lo != null) { const n = parseFloat(String(lo)); if (n >= 10000) amounts.push(n); }
      if (hi != null) { const n = parseFloat(String(hi)); if (n >= 10000) amounts.push(n); }
      continue;
    }
    if (Array.isArray(raw)) {
      const str = raw.join(' ');
      for (const m of (str.matchAll(DOLLAR_RE) || [])) {
        const n = parseDollar(m[0]);
        if (n !== null && n >= 10000) amounts.push(n);
      }
      continue;
    }
    if (typeof raw === 'number') {
      if (raw >= 10000) amounts.push(raw);
      continue;
    }
    const str = String(raw).trim();
    if (!str || ['none', 'null', 'n/a', ''].includes(str.toLowerCase())) continue;
    for (const m of (str.matchAll(DOLLAR_RE) || [])) {
      const n = parseDollar(m[0]);
      if (n !== null && n >= 10000) amounts.push(n);
    }
  }

  const unique = [...new Set(amounts.filter(v => v >= 10000).map(Math.round))].sort((a, b) => a - b);
  if (unique.length >= 2) return `$${unique[0].toLocaleString()} - $${unique[unique.length - 1].toLocaleString()}`;

  // Stage 2: content text
  const contentAmounts = collectAmounts(contentText);
  if (contentAmounts.length >= 2) {
    return `$${contentAmounts[0].toLocaleString()} - $${contentAmounts[contentAmounts.length - 1].toLocaleString()}`;
  }
  const m2 = SAL_RE.exec(contentText);
  if (m2) return m2[0];
  if (contentAmounts.length) return `$${contentAmounts[0].toLocaleString()}`;
  if (unique.length) return `$${unique[0].toLocaleString()}`;
  return '';
}

// ── Work-type normalizer ──────────────────────────────────────────────────────

const COUNTRY_REGION_RE = /^(?:united\s+states|us|usa|canada|uk|united\s+kingdom|australia|india|europe|eu|worldwide|global|international|north\s+america)\s*$/i;

function normalizeWorkType(loc, extra = '') {
  const combined = (loc + ' ' + extra).toLowerCase();
  if (combined.includes('hybrid')) return 'Hybrid';
  if (combined.includes('remote')) {
    const parts = combined.split(',').map(p => p.replace(/^us-/, '').trim());
    if (parts.length > 1) {
      const officeParts = parts.filter(p =>
        !p.includes('remote') &&
        !COUNTRY_REGION_RE.test(p.trim()) &&
        p.trim().length > 2
      );
      if (officeParts.length) return 'Hybrid';
    }
    return 'Remote';
  }
  return 'Onsite';
}

// Tag each ATS role by work type only: 'ats_remote' or 'ats_local'. These are
// not Jobright pass ids; they only mark where the role came from.
// Whether a local role is actually within reach is decided later by the
// scoring engine, which checks it against each track's own target location
// and commute radius.
function searchPass(loc, workType) {
  const wt = workType.toLowerCase();
  if (wt.includes('remote') && !wt.includes('hybrid')) return 'ats_remote';
  if (wt.includes('hybrid') || wt.includes('onsite') || wt.includes('on-site')) return 'ats_local';
  return 'ats_remote';
}

// ── Description section splitter ──────────────────────────────────────────────

const RESP_HDR = /^(what\s+you.?ll\s+do|responsibilities|the\s+role|role\s+overview|about\s+the\s+role|your\s+role|what\s+you.?ll\s+work\s+on|what\s+you.?ll\s+build|you.?ll\s+be\s+responsible)\s*$/i;
const REQ_HDR  = /^(what\s+you.?ll\s+need|basic\s+qualifications?|minimum\s+qualifications?|requirements?|qualifications?|you.?ll\s+need|who\s+you\s+are|what\s+we.?re\s+looking\s+for|must\s+have)\s*$/i;
const PREF_HDR = /^(preferred\s+qualifications?|nice\s+to\s+have|bonus\s+points?|plus\s+if\s+you|what.?s\s+a\s+plus|preferred\s+skills?)\s*$/i;

function splitDescription(text) {
  const sections = [['intro', []]];
  for (const line of text.split('\n')) {
    if (RESP_HDR.test(line))      sections.push(['resp', []]);
    else if (REQ_HDR.test(line))  sections.push(['req',  []]);
    else if (PREF_HDR.test(line)) sections.push(['pref', []]);
    else sections[sections.length - 1][1].push(line);
  }
  const get = (label) => sections.filter(([l]) => l === label).flatMap(([, lines]) => lines).join('\n');
  const resp = get('resp'), req = get('req'), pref = get('pref');
  if (!resp && !req) {
    const full = sections.flatMap(([, lines]) => lines).join('\n');
    return ['', full, ''];
  }
  return [resp, req, pref];
}

// ── Title filter ──────────────────────────────────────────────────────────────

// A posting is kept when its title names one of the roles the user is looking
// for (matched exactly as the scoring does) and no blocked title word.
function buildTitleFilter(roles, block) {
  const blkRe = block.length
    ? new RegExp('\\b(' + block.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i')
    : null;
  return (title) => {
    if (roles.length && !roles.some(r => r.re.test(title))) return false;
    if (blkRe &&  blkRe.test(title)) return false;
    return true;
  };
}

// ── Greenhouse ────────────────────────────────────────────────────────────────
// {board}/jobs lists every posting's title and location, which stays small on
// the largest boards; each matching title's text, pay, and offices come from
// {board}/jobs/{id}.

const GH_API = 'https://boards-api.greenhouse.io/v1/boards';
const GH_STATES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
  'district of columbia','dc',
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in',
  'ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv',
  'nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn',
  'tx','ut','vt','va','wa','wv','wi','wy',
]);

function ghIsVagueLocation(loc) {
  return GH_STATES.has((loc || '').trim().toLowerCase());
}

async function ghLocationFromDetail(slug, jobId, prefetched) {
  let data = prefetched;
  if (!data) {
    try {
      const r = await fetchRetry(`${GH_API}/${slug}/jobs/${jobId}`);
      data = r.status === 200 ? await r.json() : {};
    } catch { return ''; }
  }
  const offices = (data.offices || []).map(o => (o.location || '').trim()).filter(Boolean);
  if (offices.length) return offices.join('; ');
  return ((data.location || {}).name || '').trim();
}

async function ghSalaryFromDetail(slug, jobId, prefetched) {
  let data = prefetched;
  if (!data) {
    try {
      const r = await fetchRetry(`${GH_API}/${slug}/jobs/${jobId}`);
      data = r.status === 200 ? await r.json() : {};
    } catch { return ''; }
  }
  function scan(obj) {
    const found = [];
    if (typeof obj === 'string') {
      for (const m of (obj.matchAll(DOLLAR_RE) || [])) {
        const n = parseDollar(m[0]);
        if (n !== null && n >= 10000) found.push(n);
      }
    } else if (Array.isArray(obj)) {
      obj.forEach(v => found.push(...scan(v)));
    } else if (obj && typeof obj === 'object') {
      Object.values(obj).forEach(v => found.push(...scan(v)));
    }
    return found;
  }
  const amounts = [...new Set(scan(data).map(Math.round))].sort((a, b) => a - b);
  return amountsToSalary(amounts);
}

// ── Board failure registry ────────────────────────────────────────────────────
// A board that errors returns [] so one bad company cannot abort the run. That
// makes a failure look exactly like "this company has no matching roles" in the
// progress feed, which is how a rotted slug or a blocked endpoint goes unnoticed
// for weeks. Every early return records why here, and run() reports the list.
const boardFailures = [];
function noteFailure(source, company, reason, partly = false) {
  boardFailures.push({ source, company, reason, partly });
  console.log(`  [${source}] ${company}: ${reason}`);
}

// Each scraper calls report('ok') when the board answered and report('stale')
// when it does not exist (404 or similar), so the known-boards file can keep
// each board's status. A network error reports nothing.
async function scrapeGreenhouse(company, board, titleMatches, signal = null, report = () => {}) {
  let resp;
  try {
    resp = await fetchRetry(`${GH_API}/${board}/jobs`, {}, 3, signal);
  } catch (err) {
    noteFailure('GH', `${company} (${board})`, whyFailed(err));
    return [];
  }
  if (resp.status === 404) { report('stale'); noteFailure('GH', `${company} (${board})`, 'HTTP 404 - board slug may be wrong'); return []; }
  if (resp.status !== 200) { noteFailure('GH', `${company} (${board})`, `HTTP ${resp.status}`); return []; }
  report('ok');

  let jobs;
  try { jobs = (await resp.json()).jobs || []; }
  catch (err) { noteFailure('GH', `${company} (${board})`, `reading the list failed - ${withCause(err).message}`); return []; }
  const matches = [];

  for (const job of jobs) {
    if (signal?.aborted) break;
    const title = job.title || '';
    if (!titleMatches(title)) continue;

    // The list has titles only; each match's text, pay, and offices are one
    // more request. A failed one keeps the role without them.
    let detail = {};
    try {
      const dr = await fetchRetry(`${GH_API}/${board}/jobs/${job.id}`, {}, 3, signal);
      detail = dr.status === 200 ? await dr.json() : {};
    } catch { /* kept without its text */ }
    await sleep(200);

    const locName     = (job.location?.name || '').trim();
    const contentText = stripHtml(detail.content || '');
    const jobUrl      = job.absolute_url || `https://boards.greenhouse.io/${board}/jobs/${job.id}`;

    const salary = ghSalary(detail.metadata || job.metadata, contentText) || await ghSalaryFromDetail(board, job.id, detail);
    let finalLoc = locName;
    if (ghIsVagueLocation(locName)) {
      const better = await ghLocationFromDetail(board, job.id, detail);
      if (better) finalLoc = better;
    }

    const [resp_, req_, pref_] = splitDescription(contentText);
    const wt = normalizeWorkType(finalLoc);
    const sp = searchPass(finalLoc, wt);

    matches.push({
      jid:              `ats_gh_${job.id}`,
      url:              jobUrl,
      match_pct:        100,
      card_text:        `Direct ATS - ${company}`,
      company,
      title,
      location:         finalLoc,
      work_type:        wt || 'Unknown',
      salary,
      responsibilities: resp_.slice(0, 2500),
      required_quals:   req_.slice(0, 2500),
      preferred_quals:  pref_.slice(0, 2000),
      ats_url:          jobUrl,
      error:            null,
      search_pass:      sp,
    });
  }

  console.log(`  [GH] ${company} (${board}): ${jobs.length} jobs -> ${matches.length} matches`);
  return matches;
}

// ── Lever ─────────────────────────────────────────────────────────────────────

const LEVER_PAGE = 100;

async function scrapeLever(company, slug, titleMatches, signal = null, report = () => {}) {
  // Read LEVER_PAGE postings at a time until a short page.
  const label = `${company} (${slug})`;
  const jobs = [];
  for (let skip = 0; ; skip += LEVER_PAGE) {
    if (signal?.aborted) break;
    let data;
    try {
      const resp = await fetchRetry(`https://api.lever.co/v0/postings/${slug}?mode=json&skip=${skip}&limit=${LEVER_PAGE}`, {}, 3, signal);
      if (!skip && [404, 403].includes(resp.status)) { report('stale'); noteFailure('LV', label, `HTTP ${resp.status} - board slug may be wrong`); return []; }
      if (resp.status !== 200) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
      data = await resp.json();
    } catch (err) {
      const why = whyFailed(err);
      if (!skip) { noteFailure('LV', label, why); return []; }
      noteFailure('LV', label, `read partly, kept ${jobs.length} postings - ${why}`, true);
      break;
    }
    if (!skip) report('ok');
    const page = Array.isArray(data) ? data : (data.data || []);
    jobs.push(...page);
    if (page.length < LEVER_PAGE) break;
    await sleep(200);
  }
  const matches = [];

  for (const job of jobs) {
    const title = job.text || '';
    if (!titleMatches(title)) continue;

    const cats    = job.categories || {};
    const locName = cats.location || cats.city || '';
    const wtRaw   = cats.commitment || '';
    const lists   = job.lists || [];
    const desc    = stripHtml(job.description || job.descriptionPlain || '');
    let req_ = '', pref_ = '';

    for (const lst of lists) {
      const heading = (lst.text || '').toLowerCase();
      const content = stripHtml(lst.content || '');
      if (['qualif', 'requirement', 'you need', 'looking for', 'what we need'].some(k => heading.includes(k))) {
        if (['preferred', 'nice', 'bonus', 'plus'].some(k => heading.includes(k))) pref_ += content + '\n';
        else req_ += content + '\n';
      }
    }

    const salary  = extractSalary(desc + req_);
    const wt      = normalizeWorkType(locName, wtRaw);
    const sp      = searchPass(locName, wt);
    const jobUrl  = job.hostedUrl || job.applyUrl || '';

    matches.push({
      jid:              `ats_lv_${job.id || ''}`,
      employment_type:  cats.commitment || '',
      url:              jobUrl,
      match_pct:        100,
      card_text:        `Direct ATS - ${company}`,
      company,
      title,
      location:         locName,
      work_type:        wt || 'Unknown',
      salary,
      responsibilities: desc.slice(0, 2500),
      required_quals:   req_.slice(0, 2500),
      preferred_quals:  pref_.slice(0, 2000),
      ats_url:          jobUrl,
      error:            null,
      search_pass:      sp,
    });
  }

  console.log(`  [LV] ${company} (${slug}): ${jobs.length} postings -> ${matches.length} matches`);
  return matches;
}

// ── Ashby ─────────────────────────────────────────────────────────────────────

const ASHBY_GQL = 'https://jobs.ashbyhq.com/api/non-user-graphql';

const ASHBY_LIST_QUERY = `
query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings {
      id title locationName workplaceType employmentType compensationTierSummary
    }
  }
}`;

const ASHBY_DETAIL_QUERY = `
query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    descriptionHtml
  }
}`;

const ASHBY_NEXT_DATA_RE = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>(.*?)<\/script>/is;

// Returns { postings, exists }: exists is false only when the hosted page shows
// that no such board exists (an unknown board name is titled just "Jobs").
async function ashbyHtmlFallback(slug) {
  let exists = null;
  try {
    const r = await fetchRetry(`https://jobs.ashbyhq.com/${slug}`);
    if (r.status === 404) return { postings: [], exists: false };
    if (r.status !== 200) return { postings: [], exists };
    const text = await r.text();
    const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(text) || [, ''])[1].trim();
    exists = !/^jobs$/i.test(title);
    const m = ASHBY_NEXT_DATA_RE.exec(text);
    if (!m) return { postings: [], exists };
    const data = JSON.parse(m[1]);
    const pp = data?.props?.pageProps || {};
    for (const key of ['jobBoardWithTeams', 'jobBoard', 'board', 'jobPostings']) {
      const node = pp[key];
      if (Array.isArray(node) && node.length) return { postings: node, exists };
      if (node && typeof node === 'object') {
        for (const sub of ['jobPostings', 'jobs']) {
          const postings = node[sub];
          if (Array.isArray(postings) && postings.length) return { postings, exists };
        }
      }
    }
    function findPostings(obj, depth = 0) {
      if (depth > 8) return [];
      if (Array.isArray(obj) && obj.length && typeof obj[0] === 'object') {
        if ('id' in obj[0] && ('title' in obj[0] || 'name' in obj[0])) return obj;
      }
      if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) {
          const hit = findPostings(v, depth + 1);
          if (hit.length) return hit;
        }
      }
      return [];
    }
    return { postings: findPostings(pp), exists };
  } catch { return { postings: [], exists }; }
}

async function scrapeAshby(company, slug, titleMatches, signal = null, report = () => {}) {
  let postings = [];
  let usedFallback = false;
  let boardFound = false;

  try {
    const r = await fetchRetry(ASHBY_GQL + '?op=ApiJobBoardWithTeams', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        operationName: 'ApiJobBoardWithTeams',
        variables:     { organizationHostedJobsPageName: slug },
        query:         ASHBY_LIST_QUERY,
      }),
    }, 3, signal);
    const gql = await r.json();
    const boardNode = gql?.data?.jobBoardWithTeams;
    if (boardNode) {
      boardFound = true;
      postings = boardNode.jobPostings || [];
    } else {
      const errs = (gql?.errors || []).map(e => e.message).join('; ');
      console.log(`  [AS] ${company} (${slug}): GraphQL - ${errs || 'null jobBoardWithTeams'}`);
    }
  } catch (err) {
    console.log(`  [AS] ${company} (${slug}): GraphQL error - ${err.message}`);
  }

  if (boardFound) report('ok');
  if (!postings.length) {
    const fallback = await ashbyHtmlFallback(slug);
    postings = fallback.postings;
    usedFallback = !!postings.length;
    if (!boardFound && (usedFallback || fallback.exists)) report('ok');
    if (!boardFound && fallback.exists === false) report('stale');
    if (usedFallback) {
      console.log(`  [AS] ${company} (${slug}): GraphQL 0; HTML fallback found ${postings.length}`);
    } else {
      // Both the API and the HTML fallback came back empty. Ashby boards that
      // genuinely have no openings also land here, so this is reported as a
      // board to check rather than a hard error.
      noteFailure('AS', `${company} (${slug})`, '0 postings via GraphQL and HTML fallback');
    }
  }

  const matches = [];

  for (const posting of postings) {
    if (signal?.aborted) break;
    const title = posting.title || '';
    if (!titleMatches(title)) continue;

    const jobId     = posting.id || '';
    const locName   = posting.locationName || '';
    const workplace = (posting.workplaceType || '').toUpperCase();
    const jobUrl    = `https://jobs.ashbyhq.com/${slug}/${jobId}`;

    let descText = '';
    if (jobId) {
      try {
        const dr = await fetchRetry(ASHBY_GQL + '?op=ApiJobPosting', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            operationName: 'ApiJobPosting',
            variables:     { organizationHostedJobsPageName: slug, jobPostingId: jobId },
            query:         ASHBY_DETAIL_QUERY,
          }),
        }, 3, signal);
        const dj = await dr.json();
        descText = stripHtml(dj?.data?.jobPosting?.descriptionHtml || '');
      } catch { /* ignore */ }
      await sleep(300);
    }

    const compSummary = (posting.compensationTierSummary || '').trim();
    let salary = extractSalary(compSummary) || extractSalary(descText);
    if (!salary) salary = amountsToSalary(collectAmounts(compSummary + ' ' + descText));

    const [resp_, req_, pref_] = splitDescription(descText);
    const wt = workplace === 'REMOTE' ? 'Remote'
             : workplace === 'HYBRID' ? 'Hybrid'
             : normalizeWorkType(locName);
    const sp = searchPass(locName, wt);

    matches.push({
      jid:              `ats_as_${jobId}`,
      employment_type:  posting.employmentType || '',
      url:              jobUrl,
      match_pct:        100,
      card_text:        `Direct ATS - ${company}`,
      company,
      title,
      location:         locName,
      work_type:        wt || 'Unknown',
      salary,
      responsibilities: resp_.slice(0, 2500),
      required_quals:   req_.slice(0, 2500),
      preferred_quals:  pref_.slice(0, 2000),
      ats_url:          jobUrl,
      error:            null,
      search_pass:      sp,
    });
  }

  const src = usedFallback ? 'HTML fallback' : 'GraphQL';
  console.log(`  [AS] ${company} (${slug}): ${postings.length} via ${src} -> ${matches.length} matches`);
  return matches;
}

// ── Workday ───────────────────────────────────────────────────────────────────

const WD_DESC_PATHS = [
  [['jobPostingInfo'], 'jobDescription'],
  [['jobPostingInfo'], 'description'],
  [['jobRequisition'], 'jobDescription'],
  [[], 'jobDescription'],
  [[], 'description'],
];
const WD_REQ_PATHS = [
  [['jobPostingInfo'], 'qualifications'],
  [['jobPostingInfo'], 'responsibilities'],
  [['jobRequisition'], 'qualifications'],
  [[], 'qualifications'],
  [[], 'requirements'],
];

function wdJobId(extPath) {
  return (extPath || '').replace(/\/$/, '').split('/').pop() || '';
}

// Extract a Workday requisition id (the stable "Reqid" / job ID). Workday lists
// the same requisition once per authorized location with different externalPaths,
// so we dedup on this rather than the path. The req id is usually in bulletFields;
// fall back to a req-like token at the tail of the externalPath.
function wdReqId(job) {
  const fields = Array.isArray(job && job.bulletFields) ? job.bulletFields : [];
  for (const f of fields) {
    const m = String(f).match(/\b[A-Za-z]{0,5}-?\d{4,}\b/);
    if (m) return m[0].toUpperCase();
  }
  const tail = ((job && job.externalPath) || '').split('/').pop() || '';
  const m2 = tail.match(/([A-Za-z]{0,5}-?\d{4,})(?:[-_]\d{1,3})?$/);
  return m2 ? m2[1].toUpperCase() : null;
}

function probe(data, pathArr, field) {
  let node = data;
  for (const key of pathArr) {
    if (!node || typeof node !== 'object') return '';
    node = node[key];
  }
  if (!node || typeof node !== 'object') return '';
  return stripHtml(node[field] || '');
}

function parseWdApi(data) {
  let desc = '', req = '';
  for (const [p, f] of WD_DESC_PATHS) { const v = probe(data, p, f); if (v) { desc = v; break; } }
  for (const [p, f] of WD_REQ_PATHS)  { const v = probe(data, p, f); if (v) { req  = v; break; } }
  return { desc, req, method: 'api' };
}

const WD_JSONLD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/is;
const WD_EMBEDDED_RES = [
  /"jobDescription"\s*:\s*"((?:[^"\\]|\\.)+)"/i,
  /"description"\s*:\s*"((?:[^"\\]|\\.){50,})"/i,
];
const WD_REQ_EMBEDDED = /"qualifications?"\s*:\s*"((?:[^"\\]|\\.)+)"/i;

function parseWdHtml(htmlText) {
  const m = WD_JSONLD_RE.exec(htmlText);
  if (m) {
    try {
      const ld = JSON.parse(m[1]);
      const raw = ld.description || '';
      if (raw) return { desc: stripHtml(raw), req: '', method: 'html_jsonld' };
    } catch { /* fall through */ }
  }
  for (const pat of WD_EMBEDDED_RES) {
    const em = pat.exec(htmlText);
    if (em) {
      try {
        const text = stripHtml(JSON.parse('"' + em[1] + '"'));
        if (text.length > 80) {
          const rm = WD_REQ_EMBEDDED.exec(htmlText);
          const req = rm ? stripHtml(JSON.parse('"' + rm[1] + '"')) : '';
          return { desc: text, req, method: 'html_embedded' };
        }
      } catch { continue; }
    }
  }
  return {};
}

// Where a Workday board's pages live: after the site name on a company's own
// Workday host, after recruiting/{tenant}/ on the shared myworkdaysite.com host.
function wdSitePath(baseUrl, tenant, site) {
  return /\.myworkdaysite\.com$/i.test(new URL(baseUrl).hostname) ? `recruiting/${tenant}/${site}` : site;
}

// A posting's detail: { desc, req, method, locations }. The board's data
// for the posting (its search path, under /wday/cxs) has the text and every
// location; the posting's web page is the fallback, with the text only.
async function fetchWdDescription(baseUrl, tenant, site, extPath, signal = null) {
  if (signal?.aborted) return {};
  try {
    const r = await fetchRetry(`${baseUrl}/wday/cxs/${tenant}/${site}${extPath}`, {}, 3, signal);
    if (r.status === 200) {
      const data = await r.json();
      const parsed = parseWdApi(data);
      const info = data?.jobPostingInfo || {};
      parsed.locations = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])]
        .filter(l => typeof l === 'string' && l.trim());
      if (parsed.desc || parsed.req) return parsed;
    }
  } catch { /* the web page below */ }
  const pageUrl = `${baseUrl}/en-US/${wdSitePath(baseUrl, tenant, site)}${extPath}`;
  try {
    const r = await fetchRetry(pageUrl, {}, 3, signal);
    if (r.status === 200) {
      const parsed = parseWdHtml(await r.text());
      if (Object.keys(parsed).length) return parsed;
    }
  } catch { /* ignore */ }
  return {};
}

async function scrapeWorkday(company, baseUrl, tenant, site, searchTerms, titleMatches, signal = null, report = () => {}) {
  const searchUrl = `${baseUrl}/wday/cxs/${tenant}/${site}/jobs`;
  const allJobs   = [];

  for (const keyword of searchTerms) {
    let offset = 0;
    while (true) {
      let r;
      if (signal?.aborted) break;
      try {
        r = await fetchRetry(searchUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: keyword }),
        }, 3, signal);
      } catch (err) {
        noteFailure('WD', company, whyFailed(err));
        break;
      }
      if ([403, 404, 422].includes(r.status)) {
        report('stale');
        noteFailure('WD', `${company} (${tenant}/${site})`, `HTTP ${r.status} - site slug may be wrong`);
        return [];
      }
      if (r.status !== 200) { noteFailure('WD', company, `HTTP ${r.status}`); break; }
      report('ok');

      let data;
      try { data = await r.json(); }
      catch (err) { noteFailure('WD', company, `JSON parse error - ${err.message}`); break; }

      const batch = data.jobPostings || [];
      const total = data.total || 0;
      allJobs.push(...batch);
      offset += batch.length;
      if (offset >= total || !batch.length) break;
      await sleep(300);
    }
  }

  // Dedup within this company. Prefer the requisition id (so the same job listed
  // across many authorized states collapses to one); fall back to the path.
  const seenPaths = new Set();
  const unique = [];
  for (const j of allJobs) {
    const reqid = wdReqId(j);
    const key = reqid ? `req:${reqid}` : (j.externalPath || j.title || '');
    if (!seenPaths.has(key)) { seenPaths.add(key); unique.push(j); }
  }

  const methodCounts = {};
  const results = [];

  for (const job of unique) {
    if (signal?.aborted) break;
    const title = job.title || '';
    if (!titleMatches(title)) continue;

    const extPath = job.externalPath || '';
    const jobId   = wdJobId(extPath);
    const jobUrl  = extPath ? `${baseUrl}/en-US/${wdSitePath(baseUrl, tenant, site)}${extPath}` : '';
    let detail = {};
    if (extPath) {
      detail = await fetchWdDescription(baseUrl, tenant, site, extPath, signal);
      await sleep(400);
    }
    // The list gives one location or a count ("3 Locations"); the detail has them all.
    const locName = detail.locations?.length ? detail.locations.join('; ') : (job.locationsText || '');
    const wt      = normalizeWorkType(locName);
    const sp      = searchPass(locName, wt);

    const desc = detail.desc || '';
    const req  = detail.req  || '';
    const meth = detail.method || 'unavailable';
    methodCounts[meth] = (methodCounts[meth] || 0) + 1;

    const fullText = [desc, req].filter(Boolean).join('\n');
    const [resp_, req_, pref_] = splitDescription(fullText);
    const salary = extractSalary(fullText);

    // Prefer the requisition id so the same job dedups across runs too; then the
    // posting id; then a title+location hash as a last resort.
    const reqid = wdReqId(job);
    const jid = reqid
      ? `ats_wd_${tenant}_${reqid}`
      : jobId
        ? `ats_wd_${tenant}_${jobId}`
        : `ats_wd_${tenant}_${Math.abs(hashCode(title + locName))}`;

    results.push({
      jid,
      url:              jobUrl,
      match_pct:        100,
      card_text:        `Direct ATS - ${company}`,
      company,
      title,
      location:         locName,
      work_type:        wt || 'Unknown',
      salary,
      responsibilities: resp_.slice(0, 2500),
      required_quals:   req_.slice(0, 2500),
      preferred_quals:  pref_.slice(0, 2000),
      ats_url:          jobUrl,
      error:            (desc || req) ? null : 'description_unavailable',
      search_pass:      sp,
    });
  }

  const methSummary = Object.entries(methodCounts).map(([k, v]) => `${v} via ${k}`).join(', ');
  console.log(`  [WD] ${company} (${tenant}/${site}): ${unique.length} total -> ${results.length} matches` +
              (methSummary ? ` (${methSummary})` : ''));
  return results;
}

// Simple djb2-style hash for fallback jid
function hashCode(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

// ── Shared helpers for the systems below ─────────────────────────────────────

// One posting in the record format the other scrapers build by hand. text is
// the description as plain text; salary, when not given, is read from it.
function atsRecord({ jid, company, title, location = '', workType = '', text = '', salary = '', url, employmentType = '', avoided = null }) {
  const [resp_, req_, pref_] = splitDescription(text);
  const wt = workType || normalizeWorkType(location);
  return {
    jid,
    ...(employmentType ? { employment_type: employmentType } : {}),
    url,
    match_pct:        100,
    card_text:        `Direct ATS - ${company}`,
    company,
    title,
    location,
    work_type:        wt || 'Unknown',
    salary:           salary || extractSalary(text) || amountsToSalary(collectAmounts(text)),
    responsibilities: resp_.slice(0, 2500),
    required_quals:   req_.slice(0, 2500),
    preferred_quals:  pref_.slice(0, 2000),
    ats_url:          url,
    error:            text || avoided ? null : 'description_unavailable',
    search_pass:      searchPass(location, wt),
    ...(avoided ? { avoided } : {}),
  };
}

// Splits the matches of a search into those to read in full and those every
// track rejects on their place alone (see eval.placeChecker), which keep the
// reason and are not opened. Returns [[item, reason or null]].
async function byPlace(items, placeOf, placeCheck) {
  const out = [];
  for (const it of items) out.push([it, await placeCheck(placeOf(it))]);
  return out;
}
const noPlaceCheck = Object.assign(async () => null, { acceptsRemote: true });
const placeNote = decided => {
  const n = decided.filter(([, why]) => why).length;
  return n ? `, ${n} rejected on location without opening` : '';
};

// GET a URL as JSON. Throws an Error with .status when the answer is not a
// 200 with a JSON body, so callers can tell a missing board (404) from the rest.
async function getJson(url, signal) {
  const r = await fetchRetry(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, 3, signal);
  const data = r.status === 200 ? await r.json().catch(() => null) : null;
  if (data == null) { const err = new Error(`HTTP ${r.status}`); err.status = r.status; throw err; }
  return data;
}

// What a scraper does when its board's list cannot be read: a board that no
// longer exists is reported stale; anything else is only noted.
const GONE = new Set([400, 403, 404, 410]);
function boardError(tag, label, err, report) {
  if (GONE.has(err.status)) { report('stale'); noteFailure(tag, label, `HTTP ${err.status} - board may have moved`); }
  else noteFailure(tag, label, whyFailed(err));
}
// A search by title that ended partway: the roles found so far are kept.
function stoppedEarly(tag, label, found) {
  const err = found.stoppedBy;
  noteFailure(tag, label, `searched partly, kept ${found.length} - ${whyFailed(err)}`, true);
}

// Boards searched once per title, like Workday, because their lists are too
// large to read whole. Results come most relevant first, so a title's search
// stops after DRY_PAGES pages in a row with no matching title not already
// found (titles overlap, so later ones mostly find the same postings again).
const SEARCHED_BY_TERM = new Set(['workday', 'eightfold', 'oracle']);
// How many lanes of boards are read at once, and how many lanes the boards on
// one shared API are split into (see run()).
const LANES_AT_ONCE = 6;
const SHARED_LANES  = 2;
const DRY_PAGES = 3;
const MAX_PAGES = 30;

// fetchPage(term, page) -> { items, more }. Returns the matching items, each
// once, in the order found. A page that fails after the board has answered
// ends the search there: the items found so far are returned, with the error
// as their stoppedBy. A failure on the very first page is thrown.
// keep(item), when given, must also hold for an item to count as a match;
// with firstTermOnly, the search ends after a first title that found nothing.
async function searchByTerms(terms, fetchPage, { idOf, titleOf, titleMatches, signal, keep = null, firstTermOnly = false }) {
  const found = new Map();
  let answered = false;
  for (const [t, term] of terms.entries()) {
    if (firstTermOnly && t === 1 && !found.size) break;
    let dry = 0;
    for (let page = 0; page < MAX_PAGES && dry < DRY_PAGES; page++) {
      if (signal?.aborted) return [...found.values()];
      let items, more;
      try {
        ({ items, more } = await fetchPage(term, page));
      } catch (err) {
        if (!answered) throw err;
        return Object.assign([...found.values()], { stoppedBy: err });
      }
      answered = true;
      let hit = false;
      for (const it of items) {
        if (!titleMatches(titleOf(it)) || (keep && !keep(it)) || found.has(idOf(it))) continue;
        hit = true;
        found.set(idOf(it), it);
      }
      dry = hit ? 0 : dry + 1;
      if (!more || !items.length) break;
      await sleep(300);
    }
  }
  return [...found.values()];
}

// The detail of each matching posting, one request at a time; a failed one
// leaves that posting without a description rather than dropping it.
async function withDetails(items, getDetail, signal) {
  const out = [];
  for (const it of items) {
    if (signal?.aborted) break;
    let detail = null;
    try { detail = await getDetail(it); } catch { /* kept without a description */ }
    out.push([it, detail]);
    await sleep(300);
  }
  return out;
}

// A pay range given as data rather than text: every amount of 10,000 or more
// found in it, lowest to highest.
function payRange(data) {
  const nums = (JSON.stringify(data || '').match(/\d{5,}(?:\.\d+)?/g) || []).map(Number).filter(n => n >= 10000 && n < 10000000);
  return amountsToSalary([...new Set(nums.map(Math.round))].sort((a, b) => a - b));
}

const workTypeWord = v => {
  const s = String(v || '').toLowerCase();
  return /remote/.test(s) ? 'Remote' : /hybrid/.test(s) ? 'Hybrid' : /on.?site|office|in.?person/.test(s) ? 'Onsite' : '';
};

// ── Gem ───────────────────────────────────────────────────────────────────────
// api.gem.com/job_board/v0/{board}/job_posts/: every posting, with its text.

async function scrapeGem(company, { slug }, { titleMatches, signal, report }) {
  const label = `${company} (${slug})`;
  let posts;
  try { posts = await getJson(`https://api.gem.com/job_board/v0/${encodeURIComponent(slug)}/job_posts/`, signal); }
  catch (err) { boardError('GM', label, err, report); return []; }
  report('ok');
  const list = Array.isArray(posts) ? posts : [];
  const matches = list.filter(p => titleMatches(p.title || '')).map(p => atsRecord({
    jid: `ats_gm_${p.id}`, company, title: p.title || '',
    location: p.location?.name || (p.offices || []).map(o => o.location?.name || o.name).filter(Boolean).join('; '),
    workType: workTypeWord(p.location_type),
    text: p.content_plain || stripHtml(p.content || ''),
    url: p.absolute_url || `https://jobs.gem.com/${slug}/${p.id}`,
    employmentType: p.employment_type || '',
  }));
  console.log(`  [GM] ${label}: ${list.length} postings -> ${matches.length} matches`);
  return matches;
}

// ── Rippling ──────────────────────────────────────────────────────────────────
// api.rippling.com/platform/api/ats/v1/board/{board}/jobs: titles only; each
// matching posting's text is one more request.

async function scrapeRippling(company, { slug }, { titleMatches, signal, report }) {
  const label = `${company} (${slug})`;
  const api = `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`;
  let list;
  try { list = await getJson(api, signal); }
  catch (err) { boardError('RP', label, err, report); return []; }
  report('ok');
  list = Array.isArray(list) ? list : [];
  const wanted = list.filter(j => titleMatches(j.name || ''));
  const detailed = await withDetails(wanted, j => getJson(`${api}/${encodeURIComponent(j.uuid)}`, signal), signal);
  const matches = detailed.map(([j, d]) => {
    const desc = d?.description || {};
    const text = [desc.role, desc.company].filter(Boolean).map(stripHtml).join('\n');
    const places = (d?.workLocations || []).map(w => (typeof w === 'string' ? w : w?.label || w?.name)).filter(Boolean);
    const location = j.workLocation?.label || places.join('; ');
    return atsRecord({
      jid: `ats_rp_${j.uuid}`, company, title: j.name || '', location,
      workType: workTypeWord(location),
      text, salary: payRange(d?.payRangeDetails),
      url: j.url || `https://ats.rippling.com/${slug}/jobs/${j.uuid}`,
      employmentType: typeof d?.employmentType === 'string' ? d.employmentType : d?.employmentType?.label || '',
    });
  });
  console.log(`  [RP] ${label}: ${list.length} postings -> ${matches.length} matches`);
  return matches;
}

// ── Workable ──────────────────────────────────────────────────────────────────
// apply.workable.com/api/v1/widget/accounts/{board}?details=true: every
// posting, with its text.

async function scrapeWorkable(company, { slug }, { titleMatches, signal, report }) {
  const label = `${company} (${slug})`;
  let data;
  try { data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`, signal); }
  catch (err) { boardError('WK', label, err, report); return []; }
  report('ok');
  const list = Array.isArray(data.jobs) ? data.jobs : [];
  const matches = list.filter(j => titleMatches(j.title || '')).map(j => {
    const location = [j.city, j.state, j.country].filter(Boolean).join(', ');
    return atsRecord({
      jid: `ats_wk_${j.shortcode}`, company, title: j.title || '', location,
      workType: j.telecommuting ? 'Remote' : workTypeWord(j.workplace),
      text: stripHtml([j.description, j.requirements, j.benefits].filter(Boolean).join('\n')),
      url: j.url || j.shortlink || `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
      employmentType: j.employment_type || '',
    });
  });
  console.log(`  [WK] ${label}: ${list.length} postings -> ${matches.length} matches`);
  return matches;
}

// ── iCIMS career sites ────────────────────────────────────────────────────────
// {site}/api/jobs?page={n}&limit=100: every posting, with its text, a page at
// a time. Its keyword search matches loosely, so the whole list is read.

const ICIMS_PAGE = 100;
const ICIMS_MAX_PAGES = 50;

async function scrapeIcims(company, { base_url }, { titleMatches, signal, report }) {
  const host = new URL(base_url).hostname;
  const label = `${company} (${host})`;
  const jobs = [];
  for (let page = 1; page <= ICIMS_MAX_PAGES; page++) {
    if (signal?.aborted) break;
    let data;
    try { data = await getJson(`${base_url}/api/jobs?page=${page}&limit=${ICIMS_PAGE}`, signal); }
    catch (err) { if (page === 1) { boardError('IC', label, err, report); return []; } break; }
    if (page === 1) report('ok');
    const batch = (Array.isArray(data.jobs) ? data.jobs : []).map(j => j.data || j);
    jobs.push(...batch);
    if (!batch.length || jobs.length >= (data.totalCount || 0)) break;
    await sleep(300);
  }
  const matches = jobs.filter(j => titleMatches(j.title || '')).map(j => {
    const id = j.req_id || j.slug;
    const location = j.full_location || j.location_name || [j.city, j.state, j.country].filter(Boolean).join(', ');
    const lo = Number(j.salary_min_value) || 0, hi = Number(j.salary_max_value) || 0;
    return atsRecord({
      jid: `ats_ic_${host}_${id}`, company, title: j.title || '', location,
      text: stripHtml([j.description, j.responsibilities, j.qualifications].filter(Boolean).join('\n')),
      salary: lo >= 10000 || hi >= 10000 ? amountsToSalary([lo, hi].filter(n => n >= 10000)) : '',
      url: `${base_url}/jobs/${j.slug || id}`,
      employmentType: j.employment_type || '',
    });
  });
  console.log(`  [IC] ${label}: ${jobs.length} postings -> ${matches.length} matches`);
  return matches;
}

// ── Eightfold ─────────────────────────────────────────────────────────────────
// Ten postings a page, without text; each match's text is one more request.
// Two layouts: the older {site}/api/apply/v2/jobs?domain=&query=&start=&num=10
// with {site}/api/apply/v2/jobs/{id}, and the newer (PCSX)
// {site}/api/pcsx/search?domain=&query=&location=&start= with
// {site}/api/pcsx/position_details?position_id=&domain=. A site on the newer
// one refuses the older list with HTTP 403, so the newer is used from then on.

// Eightfold searches are limited to JobSift's country (criteria.COUNTRY),
// since every role outside it is rejected. Its sites also allow few requests,
// so each starts with EF_GAP between requests to it.
const EF_GAP = 1000;

// The filter options an Eightfold site offers for remote work, as search
// parameters. The newer search lists its filters with each answer
// (filterDef) and takes filter_<name>=<value>; the older one lists facets
// with counts and takes <name>=<value>. Its "locations" facet is skipped: its
// "Remote" entry does not filter.
function efRemoteFilters(filterDef) {
  const out = [];
  for (const f of [...(filterDef?.smartFilters || []), ...(filterDef?.allFilters || [])]) {
    if (!f?.filterName || !/multi_select/.test(f.type || '')) continue;
    for (const o of f.options || []) {
      if (typeof o?.value === 'string' && /remote/i.test(o.value)) {
        out.push({ name: f.filterName, value: o.value, param: `&filter_${encodeURIComponent(f.filterName)}=${encodeURIComponent(o.value)}` });
      }
    }
  }
  return out;
}
function efRemoteFacets(facets) {
  const out = [];
  for (const [name, values] of Object.entries(facets || {})) {
    if (/^locations?$/i.test(name) || !values || typeof values !== 'object') continue;
    for (const value of Object.keys(values)) {
      if (/remote/i.test(value)) out.push({ name, value, param: `&${encodeURIComponent(name)}=${encodeURIComponent(value)}` });
    }
  }
  return out;
}

// The searches of an Eightfold board, from your tracks (criteria
// jobrightPlan): one around each track's location, in kilometers (the unit
// Eightfold uses) with a tenth more so its distances cannot fall short of
// JobSift's, and one across that location's state, which keeps only postings
// that name the state alone and is dropped for a board where the first title
// finds none. With no location set, the whole country. remote: whether any
// track accepts remote work. { remote, places: [{ kind, location, distance, label }] }.
const KM_PER_MI = 1.609344;
function efSearchPlaces(plan) {
  const places = [];
  const seen = new Set();
  const add = where => {
    const key = `${where.kind}|${where.location}|${where.distance || ''}`;
    if (!seen.has(key)) { seen.add(key); places.push(where); }
  };
  for (const a of plan.areas || []) {
    add({ kind: 'radius', location: `${a.location}, ${COUNTRY.name}`, distance: Math.ceil(a.radius * KM_PER_MI * 1.1), label: a.location });
  }
  for (const a of plan.areas || []) {
    const state = stateNameOf(a.location);
    if (state) add({ kind: 'state', location: `${state}, ${COUNTRY.name}`, label: state });
  }
  if (!places.length) add({ kind: 'country', location: COUNTRY.name, label: COUNTRY.name });
  return { remote: !!plan.remote, places };
}
const EF_EVERYWHERE = efSearchPlaces({ remote: true, areas: [] });

async function scrapeEightfold(company, { base_url, domain }, { terms, titleMatches, signal, report, placeCheck = noPlaceCheck, efPlaces = EF_EVERYWHERE }) {
  const label = `${company} (${new URL(base_url).hostname})`;
  const d = encodeURIComponent(domain);
  let newer = false;
  let remoteQueries = null;   // from the site's own list of filters, once known
  const page = async (term, n, where) => {
    const q = encodeURIComponent(term);
    if (!newer) {
      try {
        const data = await getJson(`${base_url}/api/apply/v2/jobs?domain=${d}&query=${q}&start=${n * 10}&num=10${where.query}`, signal);
        if (!remoteQueries) remoteQueries = efRemoteFacets(data.facets);
        const items = Array.isArray(data.positions) ? data.positions : [];
        return { items, more: n * 10 + items.length < (data.count || 0) };
      } catch (err) { if (err.status !== 403) throw err; newer = true; remoteQueries = null; }
    }
    const data = (await getJson(`${base_url}/api/pcsx/search?domain=${d}&query=${q}&start=${n * 10}${where.query}`, signal)).data || {};
    if (!remoteQueries) remoteQueries = efRemoteFilters(data.filterDef);
    const items = Array.isArray(data.positions) ? data.positions : [];
    return { items, more: n * 10 + items.length < (data.count || 0) };
  };
  const remoteIds = new Set();
  const placeOf = (p, full = null) => ({
    location: p.location || full?.location || (p.locations || []).filter(x => typeof x === 'string').join('; '),
    work_type: remoteIds.has(p.id) ? 'Remote'
      : workTypeWord(p.work_location_option || p.workLocationOption || full?.work_location_option || full?.workLocationOption),
  });

  // Remote roles come with the place searches only while the site offers no
  // remote filter of its own, since the remote search below finds them then.
  const withRemote = () => (efPlaces.remote && !remoteQueries?.length ? 1 : 0);
  const queryOf = where => `&location=${encodeURIComponent(where.location)}` +
    (where.distance ? `&filter_distance=${where.distance}` : '') +
    (where.filter || `&filter_include_remote=${where.kind === 'state' ? 0 : withRemote()}`);
  const titleOf = p => p.name || p.posting_name || '';
  const search = (where, opts = {}) => searchByTerms(terms, async (term, n) => { const r = await page(term, n, { query: queryOf(where) }); report('ok'); return r; },
    { idOf: p => p.id, titleOf, titleMatches, signal, ...opts });
  const byId = new Map();
  let answered = false;
  const searchInto = async (where, opts, onFound) => {
    let more;
    try { more = await search(where, opts); }
    catch (err) {
      if (!byId.size && !answered) throw err;
      noteFailure('EF', label, `search ${where.kind === 'remote' ? 'for remote roles' : `in ${where.label}`} failed - ${whyFailed(err)}`, true);
      return;
    }
    answered = true;
    if (more.stoppedBy) stoppedEarly('EF', where.kind === 'remote' ? `${label} remote search` : label, more);
    for (const p of more) { onFound?.(p); if (!byId.has(p.id)) byId.set(p.id, p); }
  };

  // In order of value, so a site that limits requests is cut short on the
  // least useful searches: around each track's location, then remote roles,
  // then postings that name only the state.
  try {
    for (const where of efPlaces.places.filter(w => w.kind !== 'state')) {
      if (signal?.aborted) break;
      await searchInto(where);
    }
    // A site's own label for a posting's arrangement can be wrong: some sites
    // mark their remote roles on site and keep the truth in a filter. When a
    // track accepts remote work, the search is run again across the country
    // with each filter option the site offers for remote work, and what it
    // returns counts as remote.
    if (placeCheck.acceptsRemote && remoteQueries?.length) {
      for (const rq of remoteQueries) {
        if (signal?.aborted) break;
        await searchInto({ kind: 'remote', location: COUNTRY.name, filter: rq.param, label: 'remote' }, {}, p => remoteIds.add(p.id));
      }
    }
    for (const where of efPlaces.places.filter(w => w.kind === 'state')) {
      if (signal?.aborted) break;
      await searchInto(where, { keep: p => namesOnlyAState(placeOf(p).location), firstTermOnly: true });
    }
  } catch (err) { boardError('EF', label, err, report); return []; }
  const found = [...byId.values()];

  const decided = await byPlace(found, p => placeOf(p), placeCheck);
  const detail = p => (newer
    ? getJson(`${base_url}/api/pcsx/position_details?position_id=${encodeURIComponent(p.id)}&domain=${d}&hl=en`, signal).then(r => r.data || {})
    : getJson(`${base_url}/api/apply/v2/jobs/${p.id}?domain=${d}`, signal));
  // The older search sends each posting's text with the list.
  const toRead = decided.filter(([p, why]) => !why && !p.job_description).map(([p]) => p);
  const full = new Map(await withDetails(toRead, detail, signal));
  const matches = decided.map(([p, why]) => {
    const f = full.get(p) || null;
    const { location, work_type } = placeOf(p, f);
    return atsRecord({
      jid: `ats_ef_${p.id}`, company, title: p.name || p.posting_name || '', location, workType: work_type,
      text: stripHtml(f?.job_description || f?.jobDescription || p.job_description || ''),
      url: p.canonicalPositionUrl || f?.publicUrl || p.publicUrl ||
           (p.positionUrl ? `${base_url}${p.positionUrl}` : `${base_url}/careers/job/${p.id}`),
      employmentType: p.type || '',
      avoided: why,
    });
  });
  console.log(`  [EF] ${label}: ${found.length} matches${remoteIds.size ? `, ${remoteIds.size} remote by the site's filter` : ''}${placeNote(decided)}`);
  return matches;
}

// ── Oracle Recruiting Cloud ───────────────────────────────────────────────────
// {site}/hcmRestApi/resources/latest/recruitingCEJobRequisitions, searched by
// keyword 25 at a time, with a short summary; each match's full text is one
// more request to recruitingCEJobRequisitionDetails.

const ORACLE_PAGE = 25;
const oracleFinder = parts => encodeURIComponent(parts.join(','));

async function scrapeOracle(company, { base_url, site }, { terms, titleMatches, signal, report, placeCheck = noPlaceCheck }) {
  const host = new URL(base_url).hostname;
  const label = `${company} (${host}/${site})`;
  const api = `${base_url}/hcmRestApi/resources/latest`;
  let found;
  try {
    found = await searchByTerms(terms, async (term, page) => {
      // The finder's own separators are commas and semicolons.
      const keyword = term.replace(/[,;="]/g, ' ').trim();
      const finder = oracleFinder([`findReqs;siteNumber=${site}`, `keyword=${keyword}`, `limit=${ORACLE_PAGE}`, `offset=${page * ORACLE_PAGE}`]);
      const data = await getJson(`${api}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`, signal);
      report('ok');
      const node = (data.items || [])[0] || {};
      const items = Array.isArray(node.requisitionList) ? node.requisitionList : [];
      return { items, more: page * ORACLE_PAGE + items.length < (node.TotalJobsCount || 0) };
    }, { idOf: r => r.Id, titleOf: r => r.Title || '', titleMatches, signal });
  } catch (err) { boardError('OR', label, err, report); return []; }
  if (found.stoppedBy) stoppedEarly('OR', label, found);
  const placeOf = r => ({
    location: [...new Set([r.PrimaryLocation, ...(r.secondaryLocations || []).map(l => l.Name)].filter(Boolean))].join('; '),
    work_type: workTypeWord(r.WorkplaceType || r.WorkplaceTypeCode),
  });
  const decided = await byPlace(found, placeOf, placeCheck);
  const full = new Map(await withDetails(decided.filter(([, why]) => !why).map(([r]) => r), async r => {
    const finder = oracleFinder([`ById;Id="${r.Id}"`, `siteNumber=${site}`]);
    const data = await getJson(`${api}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`, signal);
    return (data.items || [])[0] || null;
  }, signal));
  const matches = decided.map(([r, why]) => {
    const f = full.get(r) || null;
    const text = f
      ? stripHtml([f.ExternalDescriptionStr, f.ExternalResponsibilitiesStr, f.ExternalQualificationsStr].filter(Boolean).join('\n'))
      : why ? '' : stripHtml(r.ShortDescriptionStr || '');
    return atsRecord({
      jid: `ats_or_${host}_${r.Id}`, company, title: r.Title || '', location: placeOf(r).location,
      workType: workTypeWord(r.WorkplaceType || f?.WorkplaceType || r.WorkplaceTypeCode),
      text,
      url: `${base_url}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
      employmentType: r.JobSchedule || r.WorkerType || '',
      avoided: why,
    });
  });
  console.log(`  [OR] ${label}: ${found.length} matches${placeNote(decided)}`);
  return matches;
}

// Each system's scraper, in the order boards are searched:
// (company, board, { terms, titleMatches, signal, report }) -> records.
const SCRAPERS = {
  greenhouse: (c, b, x) => scrapeGreenhouse(c, b.slug, x.titleMatches, x.signal, x.report),
  lever:      (c, b, x) => scrapeLever(c, b.slug, x.titleMatches, x.signal, x.report),
  ashby:      (c, b, x) => scrapeAshby(c, b.slug, x.titleMatches, x.signal, x.report),
  workday:    (c, b, x) => scrapeWorkday(c, b.base_url, b.tenant, b.site, x.terms, x.titleMatches, x.signal, x.report),
  eightfold:  scrapeEightfold,
  oracle:     scrapeOracle,
  gem:        scrapeGem,
  icims:      scrapeIcims,
  rippling:   scrapeRippling,
  workable:   scrapeWorkable,
};
// The short tag each system's lines in the run feed start with.
const TAGS = { greenhouse: 'GH', lever: 'LV', ashby: 'AS', workday: 'WD', eightfold: 'EF', oracle: 'OR',
               gem: 'GM', icims: 'IC', rippling: 'RP', workable: 'WK' };

// ── Shared boards ─────────────────────────────────────────────────────────────

// A company's name as a whole phrase, for finding it in a posting.
function nameRe(company) {
  const words = companyWords(company);
  if (words.join('').length < 3) return null;
  return new RegExp(`\\b${words.join('[\\s\\W]*')}\\b`, 'i');
}

/**
 * The roles from a board shared with another company, sorted out: a role that
 * names one of the sharing companies in its title or description is labeled
 * as that company's, and the company is recorded in kb as confirmed on this
 * board. The rest stay with the board's own company, or are dropped when the
 * board was searched only for the sharing companies.
 */
function sharedRoles(results, target, kb) {
  const sharers = target.sharedBy.map(c => ({ company: c, re: nameRe(c) })).filter(s => s.re);
  const confirmed = new Set();
  const out = [];
  for (const r of results) {
    const text = [r.title, r.responsibilities, r.required_quals, r.preferred_quals].join(' ');
    const hit = sharers.find(s => s.re.test(text));
    if (hit) {
      confirmed.add(hit.company);
      out.push({ ...r, company: hit.company, card_text: `Direct ATS - ${hit.company}` });
    } else if (target.company) {
      out.push(r);
    }
  }
  const now = new Date().toISOString();
  for (const c of confirmed) kb.note(c, { shared: { ats: target.ats, board: target.board, confirmed_at: now } });
  return out;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * run({ cfg, kb, connectionCompanies, signal, onProgress, onChecked }) -> Array of job records
 *   cfg                  the parsed config.json object
 *   kb                   the known boards (boards.KnownBoards); updated with
 *                        each board's status, saved by the caller
 *   connectionCompanies  the connections' companies, most connections first
 *                        (connections.companiesByCount), or [] when none are
 *                        imported or searching them is turned off
 *   onChecked(company)   after each of those companies is looked up
 *   onProgress(message, share)  share is how far the run is, 0 to 1: looking
 *                        up the connections' companies' boards fills the first
 *                        half when any are looked up, searching the boards the rest
 */
async function run({ cfg, kb, connectionCompanies = [], signal, onProgress, onChecked }) {
  const emit = (msg, pct) => { if (onProgress) onProgress(msg, pct); };
  boardFailures.length = 0;
  hostGap.clear(); hostNext.clear();

  const atsBoards     = cfg.ats_boards || {};
  const titleFilters  = cfg.title_filters || {};
  const conn          = cfg.connections || {};
  const recheckDays   = Math.max(1, Number(conn.recheck_days ?? boards.DEFAULT_RECHECK_DAYS) || boards.DEFAULT_RECHECK_DAYS);
  const crit          = criteriaFromConfig(cfg);
  // Workday, Eightfold, and Oracle boards are searched by keyword: the same
  // titles Jobright is searched for.
  const plan          = jobrightPlan(cfg);
  const WD_TERMS      = plan.titles;
  const titleMatches  = buildTitleFilter(
    crit.roles,
    titleFilters.title_block   || [],
  );

  // ── Boards to search ────────────────────────────────────────────────────────
  // The user's own companies first, as entered; then the connections' companies.
  // A board is searched once per run, under the first company it was added for.
  // A connection's company whose apply links lead to a board that may be
  // another company's shares that board: only the board's roles that name the
  // company are kept for it (see sharedRoles).
  const targets = [];
  const byBoard = new Map();
  const targetFor = (company, ats, board) => {
    const id = `${ats}:${boards.boardId(ats, board).toLowerCase()}`;
    if (!byBoard.has(id)) {
      const t = { company, ats, board, sharedBy: [] };
      byBoard.set(id, t);
      targets.push(t);
    }
    return byBoard.get(id);
  };
  const add = (company, ats, board) => {
    const t = targetFor(company, ats, board);
    if (t.company == null) t.company = company;   // a board added as shared takes its first owner
  };
  const addShared = (company, ats, board) => targetFor(null, ats, board).sharedBy.push(company);

  for (const { company, ats, board } of boards.boardsFromConfig(atsBoards)) add(company, ats, board);

  // Companies entered with only a careers page link: the board is found by
  // scanning the page once, then remembered in the known-boards file.
  for (const [company, careersUrl] of Object.entries(atsBoards.workday_companies || {})) {
    if (signal?.aborted) break;
    const known = kb.get(company);
    if (known && known.status === 'ok' && known.board) { add(company, known.ats, known.board); continue; }
    if (!String(careersUrl || '').trim() || !kb.isDue(company)) continue;
    emit(`Finding the job board for ${company} from its careers page`, 0);
    try {
      const res = await boards.lookup(company, kb, { careersUrl, recheckDays, signal });
      if (res.found) add(company, res.entry.ats, res.entry.board);
      else console.log(`  [discover] ${company}: no public job board found on the careers page`);
    } catch { break; }   // canceled
  }

  let searchFrom = 0;   // the share of progress the lookups below take
  if (connectionCompanies.length) {
    const own = new Set([...targets.map(t => companyKey(t.company)),
                         ...Object.keys(atsBoards.workday_companies || {}).map(companyKey)]);
    const res = await boards.checkCompanies(kb, connectionCompanies, {
      skip: own, recheckDays, signal, onChecked,
      onProgress: (n, total) => emit(`Looking up job boards for your connections' companies: ${n} of ${total}`, (n - 1) / total / 2),
    });
    if (res.looked) searchFrom = 0.5;
    for (const b of res.own) add(b.company, b.ats, b.board);
    for (const b of res.shared) addShared(b.company, b.ats, b.board);
    emit(`Searching the job boards of ${res.own.length} of your connections' companies.` +
         (res.looked ? ` Looked for ${res.looked} more and found ${res.found}.` : '') +
         (res.shared.length ? ` Checking ${res.shared.length} boards shared with another company for roles that name them.` : ''), searchFrom);
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  // Boards are read in lanes, several lanes at once. A board on its own site
  // (Workday, Eightfold, Oracle, iCIMS) is a lane by its host; boards on one
  // shared API (Greenhouse, Lever ...) split into SHARED_LANES lanes. A lane
  // reads one board at a time, so no site gets more than one search at once
  // from JobSift, while a slow or rate-limited board holds up only its lane.
  const found = new Array(targets.length);
  const placeCheck = placeChecker(cfg);
  const efPlaces = efSearchPlaces(plan);
  let done = 0;
  const tick = (msg) => { emit(msg, searchFrom + (1 - searchFrom) * (++done / (targets.length || 1))); };
  const LABEL = boards.SYSTEMS;

  const searchBoard = async (t, i) => {
    let outcome = null;
    const report = o => { outcome = o; };
    const b = t.board;
    const name = t.company || `${LABEL[t.ats]} board ${boards.boardId(t.ats, b)}`;
    let results;
    try {
      results = await SCRAPERS[t.ats](name, b, { terms: WD_TERMS, titleMatches, signal, report, placeCheck, efPlaces });
    } catch (err) {
      // One board's unexpected failure costs that board, not the run.
      noteFailure(TAGS[t.ats], name, `failed - ${withCause(err).message}`);
      results = [];
    }
    if (outcome) for (const c of [t.company, ...t.sharedBy].filter(Boolean)) kb.markSearched(c, t.ats, b, outcome);
    if (t.sharedBy.length) results = sharedRoles(results, t, kb);
    found[i] = results;
    const sofar = found.reduce((n, r) => n + (r ? r.length : 0), 0);
    tick(`${LABEL[t.ats]} · ${name}: +${results.length} (${sofar} ATS roles so far)`);
  };

  const lanes = new Map();
  const perApi = new Map();
  targets.forEach((t, i) => {
    const host = t.board?.base_url ? hostOfUrl(t.board.base_url) : '';
    if (t.ats === 'eightfold' && host && !hostGap.has(host)) hostGap.set(host, EF_GAP);
    const n = perApi.get(t.ats) || 0;
    if (!host) perApi.set(t.ats, n + 1);
    const key = host || `${t.ats}#${n % SHARED_LANES}`;
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(i);
  });
  // Lanes with more boards, and searched-by-title boards, start first.
  const weight = list => list.reduce((w, i) => w + (SEARCHED_BY_TERM.has(targets[i].ats) ? 5 : 1), 0);
  const queue = [...lanes.values()].sort((a, b) => weight(b) - weight(a));
  const worker = async () => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) {
      for (const i of lane) {
        if (signal?.aborted) return;
        await searchBoard(targets[i], i);
        await sleep(SEARCHED_BY_TERM.has(targets[i].ats) ? 1000 : 300, signal);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LANES_AT_ONCE, queue.length) }, worker));
  const allFound = found.filter(Boolean).flat();

  // Dedup by ATS URL within this run
  const seenUrls = new Set();
  const deduped  = [];
  for (const r of allFound) {
    const key = (r.ats_url || '').toLowerCase().replace(/\/$/, '') || r.jid;
    if (!seenUrls.has(key)) { seenUrls.add(key); deduped.push(r); }
  }

  console.log(`\n  ATS done - ${deduped.length} unique roles from ${targets.length} companies`);

  // Surface unreachable boards in the run feed. Without this a dead board slug
  // is silently worth zero roles and reads as a quiet market.
  // A board read partly kept what it found; the rest returned nothing.
  const partly = boardFailures.filter(f => f.partly), failed = boardFailures.filter(f => !f.partly);
  const list = fs => fs.map(f => `${f.company}: ${f.reason}`).join(' | ');
  if (failed.length) {
    console.error(`  ATS: ${failed.length} board(s) returned nothing usable - ${list(failed)}`);
    emit(`\u26a0 ${failed.length} ATS board(s) returned nothing usable - ${list(failed)}`, 1);
  }
  if (partly.length) {
    console.error(`  ATS: ${partly.length} board(s) only partly read - ${list(partly)}`);
    emit(`\u26a0 ${partly.length} ATS board(s) only partly read - ${list(partly)}`, 1);
  }

  return deduped;
}

module.exports = { run };
