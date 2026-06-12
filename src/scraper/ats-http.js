'use strict';

/**
 * src/scraper/ats-http.js
 * Port of ats_scraper_http.py — target company ATS scraper using plain fetch().
 * Supports Greenhouse, Lever, Ashby, and Workday.
 * Output format is identical to jobright.js so eval.js merges them cleanly.
 */

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchRetry(url, opts = {}, retries = 3, abortSignal = null) {
  const backoffs = [500, 1000, 2000];
  const retryOn  = new Set([429, 500, 502, 503, 504]);
  for (let i = 0; i <= retries; i++) {
    // Combine per-request timeout with caller's cancellation signal so that
    // Cancel Scrape immediately stops in-flight HTTP requests.
    const timeoutSig = AbortSignal.timeout(15000);
    const signal = abortSignal
      ? AbortSignal.any([timeoutSig, abortSignal])
      : timeoutSig;
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
        ...opts,
        signal,
      });
      if (retryOn.has(r.status) && i < retries) {
        await sleep(backoffs[i] || 2000);
        continue;
      }
      return r;
    } catch (err) {
      // Don't retry if the user explicitly cancelled
      if (abortSignal?.aborted || i === retries) throw err;
      await sleep(backoffs[i] || 2000);
    }
  }
}

// ── HTML stripping ────────────────────────────────────────────────────────────

function unescapeHtml(s) {
  // Two passes to handle double-encoded content (matches Python html.unescape x2)
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

// SAL_RE: no /g flag — only ever used with .exec() (single match per call).
// A global flag on a module-level regex makes .exec() stateful across calls.
const SAL_RE   = /\$[\d,]+(?:\.\d+)?[KkMm]?(?:\s*[-–—]\s*\$[\d,]+(?:\.\d+)?[KkMm]?)?(?:\s*\/\s*(?:yr|year|hour|hr))?/i;
// DOLLAR_RE: /gi required — used with String.matchAll() which needs the global flag.
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

function searchPass(loc, workType) {
  const wt = workType.toLowerCase();
  if (wt.includes('remote') && !wt.includes('hybrid')) return 'remote_us';
  const ll = (loc || '').toLowerCase();
  const isCA = ll.includes('california') || ll.includes(', ca') || ll.endsWith(', ca') || ll.includes(' ca ');
  if ((wt.includes('hybrid') || wt.includes('onsite') || wt.includes('on-site')) && isCA) return 'local_irl';
  return 'remote_us';
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

function buildTitleFilter(require_, block) {
  const reqRe = require_.length
    ? new RegExp('\\b(' + require_.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i')
    : null;
  const blkRe = block.length
    ? new RegExp('\\b(' + block.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i')
    : null;
  return (title) => {
    if (reqRe && !reqRe.test(title)) return false;
    if (blkRe &&  blkRe.test(title)) return false;
    return true;
  };
}

// ── Greenhouse ────────────────────────────────────────────────────────────────

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

async function scrapeGreenhouse(company, board, titleMatches, signal = null) {
  let resp;
  try {
    resp = await fetchRetry(`${GH_API}/${board}/jobs?content=true`, {}, 3, signal);
  } catch (err) {
    console.log(`  [GH] ${company} (${board}): network error - ${err.message}`);
    return [];
  }
  if (resp.status === 404) { console.log(`  [GH] ${company} (${board}): 404`); return []; }
  if (resp.status !== 200) { console.log(`  [GH] ${company} (${board}): HTTP ${resp.status}`); return []; }

  const jobs = (await resp.json()).jobs || [];
  const matches = [];

  for (const job of jobs) {
    if (signal?.aborted) break;
    const title = job.title || '';
    if (!titleMatches(title)) continue;

    const locName     = (job.location?.name || '').trim();
    const contentText = stripHtml(job.content || '');
    const jobUrl      = job.absolute_url || `https://boards.greenhouse.io/${board}/jobs/${job.id}`;

    let salary = ghSalary(job.metadata, contentText);
    const needDetail = !salary || ghIsVagueLocation(locName);
    let detailData = null;

    if (needDetail) {
      try {
        const dr = await fetchRetry(`${GH_API}/${board}/jobs/${job.id}`, {}, 3, signal);
        detailData = dr.status === 200 ? await dr.json() : {};
      } catch { detailData = {}; }
      if (!salary) salary = await ghSalaryFromDetail(board, job.id, detailData);
    }

    let finalLoc = locName;
    if (ghIsVagueLocation(locName)) {
      const better = await ghLocationFromDetail(board, job.id, detailData);
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

async function scrapeLever(company, slug, titleMatches, signal = null) {
  let resp;
  try {
    resp = await fetchRetry(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=500`, {}, 3, signal);
  } catch (err) {
    console.log(`  [LV] ${company} (${slug}): network error - ${err.message}`);
    return [];
  }
  if ([404, 403].includes(resp.status)) { console.log(`  [LV] ${company} (${slug}): ${resp.status}`); return []; }
  if (resp.status !== 200) { console.log(`  [LV] ${company} (${slug}): HTTP ${resp.status}`); return []; }

  const data = await resp.json();
  const jobs = Array.isArray(data) ? data : (data.data || []);
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

async function ashbyHtmlFallback(slug) {
  try {
    const r = await fetchRetry(`https://jobs.ashbyhq.com/${slug}`);
    if (r.status !== 200) return [];
    const text = await r.text();
    const m = ASHBY_NEXT_DATA_RE.exec(text);
    if (!m) return [];
    const data = JSON.parse(m[1]);
    const pp = data?.props?.pageProps || {};
    for (const key of ['jobBoardWithTeams', 'jobBoard', 'board', 'jobPostings']) {
      const node = pp[key];
      if (Array.isArray(node) && node.length) return node;
      if (node && typeof node === 'object') {
        for (const sub of ['jobPostings', 'jobs']) {
          const postings = node[sub];
          if (Array.isArray(postings) && postings.length) return postings;
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
    return findPostings(pp);
  } catch { return []; }
}

async function scrapeAshby(company, slug, titleMatches, signal = null) {
  let postings = [];
  let usedFallback = false;

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
      postings = boardNode.jobPostings || [];
    } else {
      const errs = (gql?.errors || []).map(e => e.message).join('; ');
      console.log(`  [AS] ${company} (${slug}): GraphQL - ${errs || 'null jobBoardWithTeams'}`);
    }
  } catch (err) {
    console.log(`  [AS] ${company} (${slug}): GraphQL error - ${err.message}`);
  }

  if (!postings.length) {
    postings = await ashbyHtmlFallback(slug);
    usedFallback = !!postings.length;
    if (usedFallback) {
      console.log(`  [AS] ${company} (${slug}): GraphQL 0; HTML fallback found ${postings.length}`);
    } else {
      console.log(`  [AS] ${company} (${slug}): 0 postings via GraphQL and HTML fallback`);
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

const WD_BASE_RE = /(https?:\/\/([a-z0-9][a-z0-9_-]*)\.wd\d+\.myworkdayjobs\.com)/i;
const WD_SITE_RE = /\/(?:en[-_][A-Z]{2}|en)\/([A-Za-z0-9][A-Za-z0-9_%-]*)/;

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

async function fetchWdDescription(baseUrl, tenant, site, jobId, extPath, signal = null) {
  const detailUrl = `${baseUrl}/wday/cxs/${tenant}/${site}/jobs/${jobId}`;
  for (const [method, extra] of [
    ['GET',  {}],
    ['POST', { headers: { 'Content-Type': 'application/json' }, body: '{}' }],
  ]) {
    if (signal?.aborted) return {};
    try {
      const r = await fetchRetry(detailUrl, { method, ...extra }, 3, signal);
      if (r.status === 200) {
        const parsed = parseWdApi(await r.json());
        if (parsed.desc || parsed.req) {
          parsed.method = `api_${method.toLowerCase()}`;
          return parsed;
        }
      }
    } catch { /* try next */ }
  }
  const pageUrl = `${baseUrl}/en-US/${site}${extPath}`;
  try {
    const r = await fetchRetry(pageUrl, {}, 3, signal);
    if (r.status === 200) {
      const parsed = parseWdHtml(await r.text());
      if (Object.keys(parsed).length) return parsed;
    }
  } catch { /* ignore */ }
  return {};
}

async function scrapeWorkday(company, baseUrl, tenant, site, searchTerms, titleMatches, signal = null) {
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
        console.log(`  [WD] ${company}: network error - ${err.message}`);
        break;
      }
      if ([403, 404, 422].includes(r.status)) {
        console.log(`  [WD] ${company} (${tenant}/${site}): HTTP ${r.status} - site slug may be wrong`);
        return [];
      }
      if (r.status !== 200) { console.log(`  [WD] ${company}: HTTP ${r.status}`); break; }

      let data;
      try { data = await r.json(); }
      catch (err) { console.log(`  [WD] ${company}: JSON parse error - ${err.message}`); break; }

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
    const jobUrl  = extPath ? `${baseUrl}/en-US/${site}${extPath}` : '';
    const locName = job.locationsText || '';
    const wt      = normalizeWorkType(locName);
    const sp      = searchPass(locName, wt);

    let detail = {};
    if (jobId && extPath) {
      detail = await fetchWdDescription(baseUrl, tenant, site, jobId, extPath, signal);
      await sleep(400);
    }

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

// Workday URL auto-discovery
async function discoverWorkdayUrl(company, hintUrl, signal = null) {
  try {
    const r = await fetchRetry(hintUrl, { redirect: 'follow' }, 3, signal);
    const searchText = r.url + '\n' + (await r.text()).slice(0, 200000);
    const bm = WD_BASE_RE.exec(searchText);
    if (!bm) { console.log(`  [WD-discover] ${company}: no Workday URL found`); return null; }
    const baseUrl = bm[1], tenant = bm[2];
    const context = searchText.slice(bm.index, bm.index + 600);
    const sm = WD_SITE_RE.exec(context);
    const site = sm ? sm[1] : tenant;
    if (!sm) console.log(`  [WD-discover] ${company}: site slug not found, defaulting to '${tenant}'`);
    return { base_url: baseUrl, tenant, site };
  } catch (err) {
    console.log(`  [WD-discover] ${company}: fetch error - ${err.message}`);
    return null;
  }
}

// Workday URL cache
function wdCachePath() {
  return path.join(app.getPath('userData'), 'workday_urls_cache.json');
}
function loadWdCache() {
  try {
    const p = wdCachePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  return {};
}
function saveWdCache(cache) {
  try { fs.writeFileSync(wdCachePath(), JSON.stringify(cache, null, 2), 'utf8'); } catch { /* ignore */ }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * run({ cfg, signal, onProgress }) -> Array of job records
 * cfg is the parsed config.json object.
 */
async function run({ cfg, signal, onProgress }) {
  const emit = (msg, pct) => { if (onProgress) onProgress(msg, pct); };

  const atsBoards     = cfg.ats_boards || {};
  const titleFilters  = cfg.title_filters || {};
  const GREENHOUSE    = atsBoards.greenhouse     || {};
  const LEVER         = atsBoards.lever          || {};
  const ASHBY         = atsBoards.ashby          || {};
  const WD_DIRECT     = atsBoards.workday_direct || {};
  const WD_COMPANIES  = atsBoards.workday_companies || {};
  const WD_TERMS      = atsBoards.workday_search_terms || [];
  const titleMatches  = buildTitleFilter(
    titleFilters.title_require || [],
    titleFilters.title_block   || [],
  );

  const allFound = [];
  const companies = Object.keys(GREENHOUSE).length +
                    Object.keys(LEVER).length +
                    Object.keys(ASHBY).length +
                    Object.keys(WD_DIRECT).length +
                    Object.keys(WD_COMPANIES).length;
  let done = 0;
  const tick = (msg) => { emit(msg, ++done / companies); };

  // ── Greenhouse ──────────────────────────────────────────────────────────────
  console.log('\n-- Greenhouse boards --');
  for (const [company, board] of Object.entries(GREENHOUSE)) {
    if (signal?.aborted) break;
    const results = await scrapeGreenhouse(company, board, titleMatches, signal);
    allFound.push(...results);
    tick(`Greenhouse · ${company}: +${results.length} (${allFound.length} ATS roles so far)`);
    await sleep(500);
  }

  // ── Lever ───────────────────────────────────────────────────────────────────
  console.log('\n-- Lever boards --');
  for (const [company, slug] of Object.entries(LEVER)) {
    if (signal?.aborted) break;
    const results = await scrapeLever(company, slug, titleMatches, signal);
    allFound.push(...results);
    tick(`Lever · ${company}: +${results.length} (${allFound.length} ATS roles so far)`);
    await sleep(500);
  }

  // ── Ashby ───────────────────────────────────────────────────────────────────
  console.log('\n-- Ashby boards --');
  for (const [company, slug] of Object.entries(ASHBY)) {
    if (signal?.aborted) break;
    const results = await scrapeAshby(company, slug, titleMatches, signal);
    allFound.push(...results);
    tick(`Ashby · ${company}: +${results.length} (${allFound.length} ATS roles so far)`);
    await sleep(500);
  }

  // ── Workday ─────────────────────────────────────────────────────────────────
  const wdCache = loadWdCache();

  for (const [company, info] of Object.entries(WD_DIRECT)) {
    if (!wdCache[company]) wdCache[company] = info;
  }
  const wdResolved = [...Object.entries(WD_DIRECT).map(([c]) => [c, wdCache[c]])];

  for (const [company, hintUrl] of Object.entries(WD_COMPANIES)) {
    if (signal?.aborted) break;
    if (wdCache[company]) {
      wdResolved.push([company, wdCache[company]]);
    } else {
      const info = await discoverWorkdayUrl(company, hintUrl, signal);
      if (info) { wdCache[company] = info; wdResolved.push([company, info]); }
      await sleep(1000);
    }
  }

  saveWdCache(wdCache);

  console.log('\n-- Workday --');
  for (const [company, info] of wdResolved) {
    if (signal?.aborted) break;
    const results = await scrapeWorkday(
      company, info.base_url, info.tenant, info.site, WD_TERMS, titleMatches, signal,
    );
    allFound.push(...results);
    tick(`Workday · ${company}: +${results.length} (${allFound.length} ATS roles so far)`);
    await sleep(1000);
  }

  // Dedup by ATS URL within this run
  const seenUrls = new Set();
  const deduped  = [];
  for (const r of allFound) {
    const key = (r.ats_url || '').toLowerCase().replace(/\/$/, '') || r.jid;
    if (!seenUrls.has(key)) { seenUrls.add(key); deduped.push(r); }
  }

  console.log(`\n  ATS done - ${deduped.length} unique roles from ${Object.keys(GREENHOUSE).length + Object.keys(LEVER).length + Object.keys(ASHBY).length + wdResolved.length} companies`);
  return deduped;
}

module.exports = { run };
