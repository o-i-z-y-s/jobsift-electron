'use strict';

/**
 * src/eval.js
 * Scoring engine.
 * run(mergePayload, cfg) -> evaluated JSON with { meta, accepted:{roles}, rejected:{roles} },
 * which is the shape ui/dashboard/index.html reads.
 * Async because geo-checking requires network calls (Nominatim API with local cache).
 */

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');
const { employmentTypeOf, sourcesFromConfig, postedByAll, groupSameJob, SOURCE_RANK, NOT_STATED } = require('./sources');
const { migrateConfig, criteriaFromConfig, scoreJob, matchRole, ageAdjust, acceptFor, industryRequired, radiusFor,
        ACCEPT, ACCEPT_LABEL } = require('./criteria');

// ── Geocode cache ─────────────────────────────────────────────────────────────

function geocachePath() {
  return path.join(app.getPath('userData'), 'geocode_cache.json');
}

let _geocache = null;
function loadGeocache() {
  if (_geocache) return _geocache;
  try {
    const p = geocachePath();
    _geocache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch { _geocache = {}; }
  return _geocache;
}
function saveGeocache() {
  if (!_geocache) return;
  try { fs.writeFileSync(geocachePath(), JSON.stringify(_geocache, null, 2), 'utf8'); } catch { /* ignore */ }
}

let _lastNominatimCall = 0;

async function geocode(query) {
  const cache = loadGeocache();
  const key = query.toLowerCase().trim();
  if (key in cache) return cache[key];

  // Nominatim rate limit: 1 req/sec
  const now = Date.now();
  const wait = 1050 - (now - _lastNominatimCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastNominatimCall = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'JobSift-electron/0.1 (job search automation)' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status !== 200) { cache[key] = null; return null; }
    const data = await r.json();
    const result = data.length
      ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
      : null;
    cache[key] = result;
    return result;
  } catch {
    cache[key] = null;
    return null;
  }
}

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns true (in range), false (out of range), or null (geocoding failed).
 */
async function multiWithinRadius(loc, targetLocation, radiusMi) {
  // Split multi-city locations and check each part
  const parts = loc.split(/[;•\/]/).map(p => p.trim()).filter(Boolean);
  const targetCoords = await geocode(targetLocation);
  if (!targetCoords) return null;

  for (const part of parts) {
    const coords = await geocode(part);
    if (!coords) continue;
    const dist = haversineMi(coords.lat, coords.lon, targetCoords.lat, targetCoords.lon);
    if (dist <= radiusMi) return true;
  }
  return false;
}

// ── Regex builder ─────────────────────────────────────────────────────────────

function buildRe(terms) {
  if (!terms || !terms.length) return /(?!)/;   // never-matching
  return new RegExp(
    '\\b(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i',
  );
}

// ── Salary helpers ────────────────────────────────────────────────────────────

const DASH_THOU_RE = /(\d{1,3})-(\d{3})\b/g;
const KM_TOK_RE    = /\$[\d,]+(?:\.\d+)?[KkMm]/g;

function normalizeSalaryDisplay(s) {
  if (!s) return s;
  s = s.replace(DASH_THOU_RE, '$1,$2');
  s = s.replace(KM_TOK_RE, tok => {
    let num = tok.replace(/^\$/, '');
    let mult = 1;
    if (/[Kk]$/.test(num)) { mult = 1000;    num = num.slice(0, -1); }
    if (/[Mm]$/.test(num)) { mult = 1000000; num = num.slice(0, -1); }
    const v = parseFloat(num.replace(/,/g, '')) * mult;
    return isNaN(v) ? tok : `$${Math.round(v).toLocaleString()}`;
  });
  s = s.replace(/(\s*[-–—]\s*)(\d[\d,]+)/g, '$1$$$2');
  return s;
}

function parseSalary(s) {
  if (!s) return [null, null];
  s = s.replace(DASH_THOU_RE, '$1,$2');
  const isHourly = /\/hr/i.test(s);
  const nums = [...s.matchAll(/[\d,]+(?:\.\d+)?/g)].map(m => {
    const cleaned = m[0].replace(/,/g, '');
    if (!cleaned) return null;
    let v = parseFloat(cleaned);
    if (isHourly) v *= 2080;
    else if (v < 1000) v *= 1000;
    return v;
  }).filter(v => v !== null);
  if (nums.length >= 2) return [nums[0], nums[1]];
  if (nums.length === 1) return [nums[0], nums[0]];
  return [null, null];
}

function salaryMid(s) {
  const [lo, hi] = parseSalary(s);
  return lo === null ? null : (lo + hi) / 2;
}

// ── Location normalization ────────────────────────────────────────────────────

const REMOTE_US_RE = /^(?:us\s*[-–—\s]?\s*remote|remote\s*[-–—\s]?\s*us(?:a)?|remote\s+in\s+the\s+us(?:a)?|united\s+states\s+remote|remote,?\s+(?:united\s+states|us(?:a)?))$/i;
const US_COUNTRY_RE = /,?\s*(?:united\s+states(?:\s+of\s+america)?|u\.?s\.?a?\.?)$/i;
const US_STATES = {
  alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',
  colorado:'CO',connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',
  hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',
  kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',
  massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',
  missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',
  oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',
  virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',
  wyoming:'WY','district of columbia':'DC',
};
const US_ABBRS = new Set(Object.values(US_STATES));

function normalizeSingleLoc(s) {
  s = (s || '').trim();
  if (!s) return s;
  if (REMOTE_US_RE.test(s)) return 'Remote - US';
  if (s.includes(',')) {
    const rawParts = s.split(',').map(p => p.trim());
    const nonRemote = rawParts.filter(p => !REMOTE_US_RE.test(p));
    if (nonRemote.length < rawParts.length) {
      s = nonRemote.filter(Boolean).join(', ') || 'Remote - US';
      if (!s) return 'Remote - US';
    }
  }
  if (s.includes(',') && /\bus-[a-z]/i.test(s)) {
    const parts = s.split(',').map(p => p.trim().replace(/^us-/i, '').trim());
    s = parts.filter(Boolean).join(', ');
  }
  const m1 = /^United\s+States,\s*(.+)$/i.exec(s);
  if (m1) s = m1[1].trim();
  s = s.replace(US_COUNTRY_RE, '').trim().replace(/,$/, '').trim();
  const parts = s.split(',').map(p => p.trim());
  if (parts.length <= 2) {
    const last = parts[parts.length - 1].trim();
    const alreadyAbbr = last.length === 2 && US_ABBRS.has(last.toUpperCase());
    if (!alreadyAbbr) {
      const mapped = parts.map(p => US_STATES[p.toLowerCase()] || p);
      s = mapped.filter(Boolean).join(', ');
    }
  }
  return s;
}

function normalizeLocationDisplay(loc) {
  if (!loc) return loc;
  const s = loc.trim();
  if (s.includes(';')) return s.split(';').map(p => normalizeSingleLoc(p)).filter(Boolean).join(' / ');
  if (s.includes('•')) return s.split('•').map(p => normalizeSingleLoc(p)).filter(Boolean).join(' / ');
  return normalizeSingleLoc(s);
}

// ── Posting age ───────────────────────────────────────────────────────────────

function daysFromCard(card) {
  const m = /(\d+)\s*(minute|hour|day|week|month)/i.exec(card);
  if (!m) return null;
  const n = parseInt(m[1], 10), unit = m[2].toLowerCase();
  if (unit.startsWith('minute')) return Math.round(n / (24 * 60) * 10) / 10;
  if (unit.startsWith('hour'))   return Math.round(n / 24 * 10) / 10;
  if (unit.startsWith('day'))    return n;
  if (unit.startsWith('week'))   return n * 7;
  return n * 30;
}

function ageLabel(days) {
  if (days === null || days === undefined) return 'Unknown';
  if (days <= 2)  return '≤2d';
  if (days <= 7)  return '3-7d';
  if (days <= 21) return '8-21d';
  if (days <= 30) return '22-30d';
  return '31+d';
}

// ── URL normalization for dedup ───────────────────────────────────────────────

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Remove tracking params
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|source|ref$|referrer)/i.test(k)) u.searchParams.delete(k);
    }
    return (u.origin + u.pathname + (u.search || '')).toLowerCase().replace(/\/$/, '');
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

// ── Work-type bucket ──────────────────────────────────────────────────────────

function wtBucket(wt) {
  const w = (wt || '').toLowerCase();
  if (w.includes('hybrid'))                                  return 'hybrid';
  if (w.includes('onsite') || w.includes('on-site') || w.includes('on site')) return 'in-person';
  return 'remote';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * run(mergePayload, cfg) -> evaluated output object
 * mergePayload: { results: [], scan_label, date, days_ago }
 * cfg: parsed config.json
 */
async function run(mergePayload, cfgIn) {
  const cfg         = migrateConfig(cfgIn).config;   // no-op for a current config
  const resultsRaw  = mergePayload.results || [];
  const scanLabel   = mergePayload.scan_label || 'This scan';
  const today       = mergePayload.date || new Date().toISOString().slice(0, 10);
  const scrapeTime  = mergePayload.time || '';
  const searchTerm  = cfg.pipeline?.search_term || '';

  // Build tracks map (ordered)
  const tracks = {};
  for (const t of (cfg.tracks || [])) tracks[t.key] = t;
  const trackPri = Object.fromEntries(Object.keys(tracks).map((k, i) => [k, i]));

  const allResults = resultsRaw;
  console.log(`  ${allResults.length} listings to evaluate`);

  // ── Pre-build regexes ──────────────────────────────────────────────────────

  const rf          = cfg.rejection_filters  || {};
  const titleFilt   = cfg.title_filters      || {};
  const compLists   = cfg.company_lists      || {};
  const crit        = criteriaFromConfig(cfg);

  const TITLE_BLOCK_RE       = buildRe(titleFilt.title_block       || []);
  const BLOCKED_INDUSTRIES_RE = buildRe(rf.blocked_industries      || []);
  const BLOCKED_COMPANIES_RE  = buildRe(compLists.blocked_companies || []);
  const TARGET_COMPANIES_RE   = buildRe(compLists.target_companies  || []);
  const DESCRIPTION_BLOCKER_RE = buildRe(rf.description_blockers   || []);

  const DOMAIN_EXP_INDS = rf.domain_experience_industries || [];
  const domIndPat = DOMAIN_EXP_INDS.length
    ? DOMAIN_EXP_INDS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    : null;
  const YEARS_IN_DOMAIN  = domIndPat ? new RegExp(`\\b(\\d+)(?:\\+|\\s*to\\s*\\d+)?\\s*years?\\s+(?:of\\s+)?(?:experience\\s+)?(?:in|within|working\\s+in)\\s+(?:the\\s+)?(?:${domIndPat})\\b`, 'i') : null;
  const DOMAIN_KNOW_REQ  = domIndPat ? new RegExp(`\\b(?:${domIndPat})\\s+(?:domain\\s+)?(?:knowledge|expertise|experience|background)\\s+(?:is\\s+)?(?:required|must|necessary|mandatory|essential)\\b`, 'i') : null;
  const DOMAIN_EXP_IN    = domIndPat ? new RegExp(`\\bexperience\\s+(?:in|with|within|working\\s+in)\\s+(?:the\\s+)?(?:${domIndPat})(?:\\s+(?:industry|sector|space|market|domain|environment))?\\b`, 'i') : null;
  const DOMAIN_EXP_REV   = domIndPat ? new RegExp(`\\b(?:${domIndPat})\\s+experience\\b`, 'i') : null;

  // Both limits are optional: blank means no limit. Years are matched as
  // literal numbers from the limit up to 30.
  const limit = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  const maxExpYrs = limit(rf.max_experience_years);
  const maxTravel = limit(rf.max_travel_pct);
  const expNums   = maxExpYrs >= 1 && maxExpYrs <= 30
    ? Array.from({ length: 31 - maxExpYrs }, (_, i) => maxExpYrs + i).join('|') : null;
  const HIGH_EXP_BAR = expNums && new RegExp(
    `\\b(${expNums})\\+?\\s*years?[''s]?\\s+(?:of\\s+)?(?:(?:relevant|related|progressive|professional|combined)\\s+)?(?:[a-z][\\w-]*\\s+){0,2}?(?:experience|management|implementing|managing)\\b` +
    `|\\b(?:minimum(?:\\s+of)?|a\\s+minimum\\s+of|over|at\\s+least)\\s+(${expNums})\\s*\\+?\\s*years?\\b`,
    'i',
  );

  const CLEARANCE_REQ   = /\b(secret clearance|top secret|ts\/sci|active clearance|security clearance required|clearance required)\b/i;
  const CLEARANCE_OBTAIN = /\b(?:ability|eligible|must be able|willing|can)\s+to\s+obtain\b.{0,60}clearance|clearance.{0,60}\b(?:ability|eligible|must be able|willing|can)\s+to\s+obtain\b/i;
  const TRAVEL_PCT_RE   = /(\d{1,3})\s*%\s*(?:domestic\s+|international\s+)?travel|travel\s+(?:up\s+to|of|required|expected)?\s*(\d{1,3})\s*%|travel\s+(?:requirement|required)[^\d]{0,10}(\d{1,3})\s*%/gi;
  const TRAVEL_HEAVY    = /\b(extensive travel|heavy travel|frequent travel|significant travel|up to 75%|up to 50%|50% travel|75% travel)\b/i;
  const DISGUISED_HYBRID = /\b([2-5]|two|three|four|five)\s*(?:[-–]\s*\d+)?\s*days?\s+(?:a|per)\s+week\s*(?:in\s*(?:the\s*)?(?:office|person|site|building))?|(?:in[\s\-]?(?:office|person|site))\s+(?:[2-5]|two|three|four|five)\s+days?\s+(?:a|per)\s+week|(?:on[\s\-]?site|in[\s\-]?office)\s+(?:presence|requirement|days?)[^.]{0,40}(?:\bweek(?:ly)?\b)/i;
  const DISGUISED_INPERSON = /(?:this\s+)?(?:role|position|job)\s+is\s+(?:fully\s+)?(?:on[\s\-]?site|in[\s\-]?person)|(?:must|required\s+to)\s+be\s+(?:on[\s\-]?site|in[\s\-]?person|in\s+(?:the\s+)?office)|100\s*%\s*(?:on[\s\-]?site|in[\s\-]?person)|fully\s+(?:on[\s\-]?site|in[\s\-]?person)(?!\s+interview)|not\s+(?:eligible|available)\s+for\s+remote|no\s+remote\s+(?:work\s+)?(?:option|available|allowed|offered)|(?:local|in[\s\-]?person)\s+candidates?\s+only/i;
  const REMOTE_NON_USA  = /\b(global|worldwide|world[.\-\s]?wide|anywhere|international|emea|apac|latam|united\s+kingdom|england|uk\b|ireland|dublin|canada|toronto|vancouver|montreal|ottawa|calgary|edmonton|germany|berlin|munich|france|paris|netherlands|amsterdam|spain|madrid|italy|milan|rome|sweden|stockholm|switzerland|zurich|belgium|brussels|portugal|lisbon|australia|sydney|melbourne|india|bangalore|bengaluru|mumbai|hyderabad|pune|chennai|japan|tokyo|south\s+korea|seoul|china|beijing|shanghai|shenzhen|singapore|israel|tel\s+aviv|dubai|uae|brazil|s[aã]o\s+paulo|argentina|buenos\s+aires|colombia)\b/i;
  const ONSITE_INTERNATIONAL = /\b(united\s+kingdom|england|wales|scotland|northern\s+ireland|netherlands|holland|amsterdam|japan|tokyo|osaka|south\s+korea|republic\s+of\s+korea|seoul|united\s+arab\s+emirates|abu\s+dhabi|dubai|israel|tel\s+aviv|germany|france|spain|italy|australia|singapore|india)\b/i;
  const FACILITY_CODE_RE = /(?:[A-Z]{1,4}\s*[-:]\s*\d{3,}|store\s+support\s+cent(?:er|re)|distribution\s+cent(?:er|re)|fulfillment\s+cent(?:er|re)|warehouse\s+\d)/i;
  const REMOTE_WORK_SIGNAL = /\b(?:fully|completely|100\s*%|entirely)[\s\-]+remote\b|\bremote[\s\-]+(?:first|only|position|role|job|opportunity|eligible|work|option|friendly)\b|\bwork(?:ing)?[\s\-]+(?:from[\s\-]+home|remotely)\b|\b(?:telecommut|wfh)\b|\bthis\s+(?:role|position|job)\s+is\s+remote\b|\beligible\s+for\s+remote\b|\bremote\s+work\s+(?:is\s+)?(?:available|allowed|supported|offered)\b|\bwork\s+from\s+anywhere\b|\bno\s+office\s+requirement\b|\bremote\s+employees?\b|\bcategorized\s+as\s+(?:a\s+)?remote\b|\bwork\s+from\s+(?:home|anywhere\b|a\s+physical\s+location)|\bno\s+permanent\s+(?:corporate\s+)?office\b/i;
  const LOC_REMOTE_OPTION = /\bremote\s+within\b|\bor\s+remote\b|^\s*(?:united\s+states(?:\s+of\s+america)?|u\.s\.a?|usa?|north\s+america)\s*$/i;
  const WORKDAY_STATE   = /\/Remote-([A-Z]{2})(?:\/|$)/i;
  const REMOTE_STATE_LOC = /\bRemote[-–,]\s*[A-Z]{2}\b|\bRemote\s+[A-Z]{2}\b/g;
  const MUST_RESIDE     = /\bmust\s+(?:be\s+)?(?:reside|located|live|be\s+based)\s+(?:in|out\s+of|within)\b/i;
  const TITLE_COUNTRY   = /\(\s*(?:uk|eu|uae|isr|japan|south\s+korea|korea|israel|netherlands)\s*\)|\b(?:south\s+korea|japan|uae|israel)\s*$|-\s*(?:uk|eu|uae|japan|south\s+korea)\b/i;

  // Per-track compiled regexes
  const trackExclRe   = {};
  const trackIndRe    = {};
  const trackTargetRe = {};
  const trackTitleBlkRe = {};
  for (const [tid, t] of Object.entries(tracks)) {
    trackExclRe[tid]     = buildRe(t.excluded_companies || []);
    trackIndRe[tid]      = buildRe(t.blocked_industries || []);
    trackTargetRe[tid]   = buildRe(t.target_companies   || []);
    trackTitleBlkRe[tid] = buildRe(t.title_block || []);
  }

  // Vague-state pattern from track target_locations
  const targetStates = new Set();
  for (const t of Object.values(tracks)) {
    if (t.target_location) {
      const parts = t.target_location.split(',').map(p => p.trim());
      if (parts.length >= 2) {
        const ab = parts[parts.length - 1].trim().toUpperCase();
        targetStates.add(ab);
        const fn = Object.entries(US_STATES).find(([, a]) => a === ab)?.[0];
        if (fn) targetStates.add(fn);
      }
    }
  }
  const VAGUE_STATE_RE = targetStates.size
    ? new RegExp(`^\\s*(?:${[...targetStates].sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*$`, 'i')
    : /(?!)/;

  const userState = cfg.user_state || '';

  // ── Evaluation loop ──────────────────────────────────────────────────────────

  // Employment type and who posted it, once per listing. Shown on every role,
  // accepted or rejected, and counted for the whole scrape.
  const src  = sourcesFromConfig(cfg);
  const byAll = postedByAll(allResults, src);
  const info = allResults.map((r, i) => ({ emp: employmentTypeOf(r), by: byAll[i] }));

  const acceptedRaw = [];
  const rejectedRaw = [];
  const hybridWarnings = [];

  const bodyText = i => `${allResults[i].responsibilities || ''} ${allResults[i].required_quals || ''}`;
  // The dashboard tab a job is shown under: its role's type (the role that
  // track accepts, for an accepted job), or "Other".
  const roleTypeOf = (title, trackId = null) => matchRole(title, crit, trackId)?.type || 'Other';

  function univRej(jid, idx, title, company, salary, wt, wbEff, loc, pct, postedDays, reason, notes, ats, sp) {
    const firstTrack = Object.keys(tracks)[0] || '';
    rejectedRaw.push({
      jid, idx, track: firstTrack, company, title, salary,
      work_type: wt, work_type_eff: wbEff, location: loc,
      match_pct: pct, posted_days: postedDays,
      reason, notes, ats, sp, text: bodyText(idx), role_cat: roleTypeOf(title),
    });
  }

  function travelPct(text) {
    const pcts = [];
    let m;
    const re = new RegExp(TRAVEL_PCT_RE.source, 'gi');
    while ((m = re.exec(text)) !== null) {
      for (const g of m.slice(1)) { if (g) pcts.push(parseInt(g, 10)); }
    }
    if (TRAVEL_HEAVY.test(text)) pcts.push(50);
    return pcts.length ? Math.max(...pcts) : null;
  }

  function checkGeoRestriction(loc, ats, card, desc) {
    const wm = WORKDAY_STATE.exec(ats);
    if (wm) {
      const state = wm[1].toUpperCase();
      if (state !== userState && state !== 'US') return `State-restricted remote: ${state} only (ATS URL)`;
    }
    const combined = (loc + ' ' + (card || '').slice(0, 200));
    const stateMatcher = /\bRemote[-–,]\s*([A-Z]{2})\b|\bRemote\s+([A-Z]{2})\b/g;
    const states = [];
    let sm;
    while ((sm = stateMatcher.exec(combined)) !== null) {
      states.push(sm[1] || sm[2]);
    }
    if (states.length && !states.includes(userState)) {
      return `State-restricted remote: ${[...new Set(states)].join(', ')} (no ${userState})`;
    }
    if (desc && MUST_RESIDE.test(desc)) {
      const mm = MUST_RESIDE.exec(desc);
      const snippet = desc.slice(mm.index, mm.index + 120).toLowerCase();
      const foundStates = Object.entries(US_STATES)
        .filter(([name]) => snippet.includes(name))
        .map(([, abbr]) => abbr);
      if (foundStates.length && !foundStates.includes(userState)) {
        return `State-restricted remote: must reside in ${foundStates.join(', ')} - no ${userState}`;
      }
    }
    return null;
  }

  // One body-text sweep per role (not per track): the disguised-arrangement and
  // hidden-location checks the track loop needs, and hidden constraints to flag.
  function analyzeBody(descBlob, title) {
    const mH = DISGUISED_HYBRID.exec(descBlob);
    const mI = DISGUISED_INPERSON.exec(descBlob);
    const statePins = [];
    const re = new RegExp(REMOTE_STATE_LOC.source, 'gi');
    let sm;
    while ((sm = re.exec(descBlob)) !== null) statePins.push(sm[0].trim());
    return {
      hybridSnippet:   mH ? mH[0].slice(0, 60) : null,
      inpersonSnippet: mI ? mI[0].slice(0, 60) : null,
      remoteSignal:    REMOTE_WORK_SIGNAL.test(descBlob + ' ' + title),
      mustReside:      MUST_RESIDE.test(descBlob),
      statePins:       [...new Set(statePins)],
    };
  }

  // ── Pre-batch geocoding ────────────────────────────────────────────────────
  // Collect every unique non-remote location that will need a radius check and
  // geocode them upfront before the eval loop. This deduplicates locations across
  // roles and tracks so each unique string is only geocoded once even when the
  // same city appears in hundreds of listings. The eval loop then hits only the
  // warm in-memory cache, no per-role network round trips.
  const geoTargets = new Set(
    Object.values(tracks)
      .filter(t => t.target_location)
      .map(t => t.target_location),
  );

  const locationsToGeocode = new Set();
  for (const r of allResults) {
    const wt = (r.work_type || '').toLowerCase();
    if (wt.includes('remote')) continue;  // remote roles skip geo check
    const loc = normalizeLocationDisplay((r.location || '').trim());
    if (loc) locationsToGeocode.add(loc);
  }
  // Also pre-warm all track target locations
  for (const t of geoTargets) locationsToGeocode.add(t);

  if (locationsToGeocode.size > 0) {
    console.log(`  Pre-geocoding ${locationsToGeocode.size} unique locations...`);
    for (const loc of locationsToGeocode) {
      // geocode() checks cache first, only hits network for new entries
      const parts = loc.split(/[;•\/]/).map(p => p.trim()).filter(Boolean);
      for (const part of parts) await geocode(part);
    }
    saveGeocache();
    console.log(`  Geocoding complete.`);
  }

  for (let idx = 0; idx < allResults.length; idx++) {
    const r = allResults[idx];
    const title   = (r.title    || '').trim();
    const company = (r.company  || '').trim();
    const salary  = normalizeSalaryDisplay(r.salary || '');
    const wt      = (r.work_type || '').trim();
    const loc     = normalizeLocationDisplay((r.location || '').trim());
    const sp      = r.search_pass || '';
    const card    = r.card_text  || '';
    const resps   = r.responsibilities || '';
    const req     = r.required_quals   || '';
    const pref    = r.preferred_quals  || '';
    const ats     = r.ats_url          || '';
    const jid     = r.jid              || '';
    const pct     = r.match_pct        ?? null;
    const [lo, hi] = parseSalary(salary);
    const mid     = salaryMid(salary);
    const noSalary = lo === null;
    const postedDays = daysFromCard(card);
    const allText  = `${title} ${company} ${resps} ${req} ${pref}`;
    const travel   = travelPct(allText);
    const clearancePresent = CLEARANCE_REQ.test(allText) || CLEARANCE_OBTAIN.test(allText);

    // Mislabeled in-person: remote-tagged but location is a specific city
    let wtMut = wt;
    const locLead = loc && loc.includes(',') ? loc.split(',')[0].trim() : loc;
    if (/remote/i.test(wt) && loc &&
        !/\b(remote|united\s+states?|usa|anywhere|worldwide|nationwide|virtual|wfh|work\s+from\s+home)\b/i.test(locLead) &&
        !/\bremote\b/i.test(allText)) {
      wtMut = 'Onsite';
    }

    const locDisplay = loc || (/remote/i.test(wtMut) ? 'Remote - US' : 'USA');
    let wb  = wtBucket(wtMut);
    const locOffersRemote = LOC_REMOTE_OPTION.test(loc || '');
    let wbEff = locOffersRemote ? 'remote' : wb;
    if (wbEff === 'hybrid' && REMOTE_WORK_SIGNAL.test(resps + ' ' + req + ' ' + pref)) {
      wbEff = 'remote';
    }

    // One body-text sweep for this role, reused by the per-track gates below.
    const bodyArr = analyzeBody(`${resps} ${req}`, title);

    // ── Universal hard disqualifiers ────────────────────────────────────────
    let done = false;

    // Rejected from its Jobright card by an Avoid rule, without being opened
    // (see avoidOnCard in scraper/jobright.js).
    if (r.avoided) {
      univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,r.avoided,'Rejected from the Jobright card; the posting was not opened',ats,sp);
      done = true;
    }
    if (!done && !resps && !req && !pref) {
      univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,'Universal: No job description available - returned empty content','',ats,sp);
      done = true;
    }
    if (!done && info[idx].by.kind === 'job_board' && src.reposts === 'reject') {
      univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Reposted by ${company}, a job board or reposting site`,'',ats,sp);
      done = true;
    }
    if (!done && crit.roles.length && !matchRole(title, crit)) {
      univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,"Universal: Title does not match any role you're looking for",'',ats,sp);
      done = true;
    }
    if (!done && BLOCKED_INDUSTRIES_RE.test(allText)) {
      univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,'Universal: Blocked industry domain','',ats,sp);
      done = true;
    }
    if (!done && BLOCKED_COMPANIES_RE.test(company)) {
      univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Blocked company - ${company}`,'',ats,sp);
      done = true;
    }
    if (!done && YEARS_IN_DOMAIN) {
      const myr = YEARS_IN_DOMAIN.exec(req);
      if (myr && parseInt(myr[1], 10) >= 3) {
        univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Requires ${myr[1]}+ yrs experience in a Domain Experience industry - '${myr[0].slice(0, 70)}'`,'',ats,sp);
        done = true;
      }
    }
    if (!done && DOMAIN_KNOW_REQ) {
      const mkn = DOMAIN_KNOW_REQ.exec(req);
      if (mkn) { univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Domain expertise required (Domain Experience industry) - '${mkn[0].slice(0,70)}'`,'',ats,sp); done = true; }
    }
    if (!done && DOMAIN_EXP_IN) {
      const mei = DOMAIN_EXP_IN.exec(req);
      if (mei) { univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Domain experience required - '${mei[0].slice(0,80)}'`,'',ats,sp); done = true; }
    }
    if (!done && DOMAIN_EXP_REV) {
      const mer = DOMAIN_EXP_REV.exec(req);
      if (mer) { univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Domain experience required - '${mer[0].slice(0,80)}'`,'',ats,sp); done = true; }
    }
    if (!done && HIGH_EXP_BAR) {
      const mexp = HIGH_EXP_BAR.exec(req + ' ' + resps.slice(0, 300));
      if (mexp) { univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Experience bar too high - '${mexp[0].slice(0,70)}'`,'',ats,sp); done = true; }
    }
    if (!done && maxTravel !== null) {
      if (travel !== null && travel > maxTravel) {
        univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Travel ${travel}% exceeds ${maxTravel}% threshold`,'',ats,sp);
        done = true;
      }
    }
    if (done) continue;

    // ── Per-track evaluation ─────────────────────────────────────────────────
    const trackRejs = {};
    let accepted = false;

    for (const [trackId, track] of Object.entries(tracks)) {
      let locStateOnly = false;   // posting gives only the state, no city
      let locGeoUnknown = false;

      // ── Geo gate ──────────────────────────────────────────────────────────
      if (wbEff === 'remote') {
        if (REMOTE_NON_USA.test(locDisplay)) {
          const ll = (locDisplay || '').toLowerCase();
          const stAbbrs = Object.values(US_STATES).join('|');
          const hasUs = ll.includes('united states') || /\bus(?:a)?\b/.test(ll) ||
                        new RegExp(`,\\s*(?:${stAbbrs})\\b`, 'i').test(locDisplay || '');
          if (!hasUs) { trackRejs[trackId] = `Geo: Remote role outside USA or global (${locDisplay})`; continue; }
        }
      } else {
        if (locDisplay && track.target_location) {
          if (VAGUE_STATE_RE.test(locDisplay.trim())) {
            locStateOnly = true;
          } else if (ONSITE_INTERNATIONAL.test(locDisplay)) {
            trackRejs[trackId] = `Geo: International location (${locDisplay})`; continue;
          } else if (FACILITY_CODE_RE.test(locDisplay)) {
            trackRejs[trackId] = `Geo: Location is a facility/store code (${locDisplay})`; continue;
          } else {
            const radius = radiusFor(track);
            const inRange = await multiWithinRadius(locDisplay, track.target_location, radius);
            if (inRange === null) {
              // Geocoding failed - state fallback
              const tgtParts = track.target_location.split(',').map(p => p.trim());
              const tgtStateAb = tgtParts.length >= 2 ? tgtParts[tgtParts.length - 1].trim().toUpperCase() : null;
              let inTargetState = false;
              if (tgtStateAb) {
                const ll = (locDisplay || '').toLowerCase();
                const tgtFull = Object.entries(US_STATES).find(([, a]) => a === tgtStateAb)?.[0] || '';
                inTargetState = tgtFull && ll.includes(tgtFull) ||
                                ll.includes(`, ${tgtStateAb.toLowerCase()}`) ||
                                ll.endsWith(`, ${tgtStateAb.toLowerCase()}`);
              }
              if (!inTargetState) {
                trackRejs[trackId] = `Geo: Location not geocodable and not in target state (${locDisplay})`; continue;
              }
              locGeoUnknown = true;
            } else if (!inRange) {
              trackRejs[trackId] = `Geo: Location outside commute range (${locDisplay})`; continue;
            }
          }
        }
      }

      // ── Work arrangement gate ──────────────────────────────────────────────
      const acceptedWt = new Set((track.work_types || []).map(w => w.toLowerCase()));
      if (wbEff === 'in-person' && !acceptedWt.has('onsite')) {
        trackRejs[trackId] = `Track ${trackId}: In-person not accepted on this track`; continue;
      }
      if (wbEff === 'hybrid' && !acceptedWt.has('hybrid') && !acceptedWt.has('onsite')) {
        trackRejs[trackId] = `Track ${trackId}: Hybrid not accepted on this track`; continue;
      }
      if (wbEff === 'remote' && !acceptedWt.has('remote')) {
        trackRejs[trackId] = `Track ${trackId}: Remote not accepted on this track`; continue;
      }

      // ── Employment type ───────────────────────────────────────────────────
      // An empty list accepts every type; a posting that states none passes.
      const empTypes = track.employment_types || [];
      if (empTypes.length && info[idx].emp !== NOT_STATED && !empTypes.includes(info[idx].emp)) {
        trackRejs[trackId] = `Track ${trackId}: ${info[idx].emp} roles not accepted on this track`; continue;
      }

      // ── Disguised hybrid/in-person ─────────────────────────────────────────
      if (wbEff === 'remote' && !acceptedWt.has('hybrid')) {
        if (bodyArr.hybridSnippet) {
          hybridWarnings.push(`${company} - ${title}: disguised hybrid '${bodyArr.hybridSnippet}'`);
          trackRejs[trackId] = `Track ${trackId}: Disguised hybrid - '${bodyArr.hybridSnippet}'`; continue;
        }
        if (bodyArr.inpersonSnippet) {
          hybridWarnings.push(`${company} - ${title}: disguised in-person '${bodyArr.inpersonSnippet}'`);
          trackRejs[trackId] = `Track ${trackId}: Disguised in-person - '${bodyArr.inpersonSnippet}'`; continue;
        }
        const locSignalsRemote = /\bremote\b/i.test(locDisplay || '') || locOffersRemote;
        if (!locSignalsRemote && !bodyArr.remoteSignal) {
          trackRejs[trackId] = `Track ${trackId}: Remote-tagged but no remote-work language in JD - likely mislabeled (${locDisplay || 'no location'})`; continue;
        }
      }

      // ── Per-track company/title filters ────────────────────────────────────
      if (trackExclRe[trackId].test(company)) {
        trackRejs[trackId] = `Track ${trackId}: Excluded company - ${company}`; continue;
      }
      const trackInd = trackIndRe[trackId].exec(allText);
      if (trackInd) {
        trackRejs[trackId] = `Track ${trackId}: Blocked industry on this track - ${trackInd[0]}`; continue;
      }
      if (trackTitleBlkRe[trackId].test(title)) {
        trackRejs[trackId] = `Track ${trackId}: Per-track blocked keyword in title - ${title}`; continue;
      }
      if (crit.roles.length && !matchRole(title, crit, trackId)) {
        trackRejs[trackId] = `Track ${trackId}: Title matches no role this track accepts - ${title}`; continue;
      }

      // ── Seniority gates ────────────────────────────────────────────────────
      if (TITLE_BLOCK_RE.test(title)) {
        trackRejs[trackId] = `Track ${trackId}: Blocked title keyword - ${title}`; continue;
      }
      if (TITLE_COUNTRY.test(title)) {
        trackRejs[trackId] = `Track ${trackId}: Country indicator in title - ${title}`; continue;
      }

      // ── Description blockers ───────────────────────────────────────────────
      if (DESCRIPTION_BLOCKER_RE.test(req)) {
        const m = DESCRIPTION_BLOCKER_RE.exec(req);
        trackRejs[trackId] = `Pre-screen: Disqualifying phrase in requirements - '${m[0].slice(0, 60)}'`; continue;
      }

      // ── Clearance ─────────────────────────────────────────────────────────
      // Only an explicit 'reject' drops the role; otherwise it is kept and
      // flagged below, so a track saved without this setting still warns.
      if (clearancePresent && track.clearance_behavior === 'reject') {
        trackRejs[trackId] = `Track ${trackId}: Security clearance required`; continue;
      }

      // ── Salary gate ────────────────────────────────────────────────────────
      if (noSalary && track.reject_if_no_salary) {
        trackRejs[trackId] = `Track ${trackId}: Salary required on this track - not disclosed`; continue;
      }

      const isTarget = TARGET_COMPANIES_RE.test(company) || trackTargetRe[trackId].test(company);
      const salFloor   = isTarget ? (track.salary_floor - (track.wiggle_room || 0)) : track.salary_floor;

      if (mid !== null && mid < salFloor) {
        trackRejs[trackId] = `Track ${trackId}: Salary midpoint $${(mid/1000).toFixed(0)}K below $${(salFloor/1000).toFixed(0)}K floor`; continue;
      }

      // ── Geo restriction in description ────────────────────────────────────
      const geoRej = checkGeoRestriction(locDisplay, ats, card, resps + ' ' + req);
      if (geoRej) { trackRejs[trackId] = `Track ${trackId}: ${geoRej}`; continue; }

      // ── Scoring ───────────────────────────────────────────────────────────
      // Match score out of 100 (see criteria.js). The track's bar is checked
      // on the job's own grade; a posting older than settings.stale_after_days
      // is accepted on that grade and then shown one grade lower.
      // For a target company the wiggle room lowers the floor for pay points
      // too, so a role let in by the wiggle room is not scored as below floor.
      const match = scoreJob({ title, text: `${title} ${resps} ${req} ${pref}`, mid, noSalary }, crit,
                             isTarget ? { ...track, salary_floor: salFloor } : track);
      const ind = match.parts.find(p => p.signal === 'Industry');
      if (ind && !ind.points && industryRequired(track)) {
        trackRejs[trackId] = `Track ${trackId}: No listed industry in the posting`; continue;
      }
      if (!match.grade) {
        trackRejs[trackId] = `Track ${trackId}: Score ${match.score} below 50 - not a match`; continue;
      }
      const accept = acceptFor(track);
      if (!ACCEPT[accept].includes(match.grade)) {
        trackRejs[trackId] = `Track ${trackId}: Grade ${match.grade} below this track's bar (accepts ${ACCEPT_LABEL[accept]})`; continue;
      }
      const aged = ageAdjust(match.grade, postedDays, cfg.settings?.stale_after_days);

      // ── Flags and notes ───────────────────────────────────────────────────
      const flags = [], notesList = [];
      if (locStateOnly)   flags.push(`Location is listed only as "${locDisplay}" - confirm it is within commute range`);
      if (locGeoUnknown)  flags.push('Location could not be verified - confirm it is within commute range');
      const by = info[idx].by;
      if (by.kind === 'job_board' && src.reposts === 'flag') {
        flags.push(`Posted by ${company}, a job board or reposting site: look for the employer's own posting`);
      } else if (by.boardLink && by.kind !== 'job_board' && src.reposts !== 'off') {
        flags.push(`Apply link is on ${by.boardLink}: look for the employer's own posting`);
      }
      if (clearancePresent) flags.push('Security clearance mentioned - check whether you hold or can obtain it');
      if (noSalary && !track.reject_if_no_salary) flags.push(`Salary not disclosed - cannot verify $${Math.floor(track.salary_floor/1000)}K floor`);
      if (aged.note)      notesList.push(aged.note);
      if (noSalary)       notesList.push('Salary not listed');
      if (travel)         notesList.push(`${travel}% travel noted`);
      if (wbEff === 'hybrid') notesList.push('Hybrid work arrangement');
      if (isTarget && mid !== null && mid < track.salary_floor) notesList.push(`Salary $${(mid/1000).toFixed(0)}K - target company wiggle room applied`);

      // Additive hidden-constraint flag for remote roles. Does NOT reject or
      // reclassify (the geo gate above already rejects clear exclusions); it only
      // marks roles whose body hides a hybrid/state-pin/residency signal so the
      // pill renders "Remote?" and the detail lands in the expandable notes.
      let arrangementUncertain = false;
      if (wbEff === 'remote') {
        const hidden = [];
        if (bodyArr.hybridSnippet)    hidden.push(`possible hybrid: '${bodyArr.hybridSnippet}'`);
        if (bodyArr.statePins.length) hidden.push(`location-pinned: ${bodyArr.statePins.join(', ')}`);
        if (bodyArr.mustReside)       hidden.push('residency requirement in description');
        if (hidden.length) {
          arrangementUncertain = true;
          flags.push('Remote? - hidden location/arrangement constraint in description - verify before applying');
          notesList.push(`Remote? - ${hidden.join('; ')}`);
        }
      }

      const prescreen = {
        title:       { pass: true,  note: 'Title accepted' },
        arrangement: { pass: true,  note: `Work arrangement: ${wbEff} accepted on ${track.label}` },
        salary:      {
          pass: !(noSalary && track.reject_if_no_salary),
          note: noSalary
            ? `Salary not disclosed - verify $${Math.floor(track.salary_floor/1000)}K floor before applying`
            : `Salary $${(mid/1000).toFixed(0)}K mid meets $${Math.floor(track.salary_floor/1000)}K floor`,
        },
      };
      if (ind) prescreen.industry = ind.points
        ? { pass: true,  note: `Industry: ${ind.detail}` }
        : { pass: false, note: 'Industry: none of your listed industries found' };

      acceptedRaw.push({
        jid, idx, track: trackId, role_cat: roleTypeOf(title, trackId),
        company, title, salary, work_type: wtMut, work_type_eff: wbEff,
        location: locDisplay, match_pct: pct, posted_days: postedDays,
        match: { score: match.score, parts: match.parts },
        fit: match.grade, grade: aged.grade, prescreen, flags, notes: notesList.join('; '),
        arrangement_uncertain: arrangementUncertain, target_company: isTarget,
        ats, sp, text: `${resps} ${req}`,
      });
      accepted = true;
      break;
    }

    if (!accepted) {
      const tried = Object.keys(trackRejs);
      const reportTrack = tried.length ? tried[tried.length - 1] : Object.keys(tracks)[0] || '';
      const primaryRej  = trackRejs[reportTrack] || 'No tracks evaluated this role';
      const allRejNotes = Object.entries(trackRejs).map(([t, v]) => `${t}: ${v}`).join(' | ');
      rejectedRaw.push({
        jid, idx, track: reportTrack, company, title, salary,
        work_type: wtMut, work_type_eff: wbEff, location: locDisplay,
        match_pct: pct, posted_days: postedDays,
        reason: primaryRej, notes: allRejNotes, ats, sp, text: `${resps} ${req}`,
        role_cat: roleTypeOf(title),
      });
    }
  }

  // Save geocache after eval loop (may have made new requests)
  saveGeocache();

  // ── Post-eval dedup by ATS URL ─────────────────────────────────────────────
  function atsKey(e) {
    const url = (e.ats || '').trim();
    if (!url) return `${e.company.toLowerCase()}|${e.title.toLowerCase()}`;
    return normalizeUrl(url);
  }

  const accByKey = {};
  for (const e of acceptedRaw) {
    const k = atsKey(e);
    if (!(k in accByKey) || trackPri[e.track] < trackPri[accByKey[k].track]) {
      accByKey[k] = e;
    }
  }
  const acceptedFinal = Object.values(accByKey);
  const acceptedKeys  = new Set(Object.keys(accByKey));

  const rejByKey = {};
  for (const e of rejectedRaw) {
    const k = atsKey(e);
    if (acceptedKeys.has(k)) continue;
    if (!(k in rejByKey) || trackPri[e.track] < trackPri[rejByKey[k].track]) {
      rejByKey[k] = e;
    }
  }
  let rejectedFinal = Object.values(rejByKey);

  // ── One job, one listing ──────────────────────────────────────────────────
  // The same title with mostly the same description from different companies
  // is one job: an employer's own posting, staffing firms filling it, job
  // boards copying it. Where any copy was accepted, the best accepted copy is
  // kept (employer, then staffing firm, then job board; then grade and score)
  // and every other copy, accepted or rejected, is listed on it instead.
  const gradeRank = g => ({ A: 0, B: 1, C: 2 }[g] ?? 3);
  const groups = groupSameJob([...acceptedFinal.map(e => ({ e, ok: true })), ...rejectedFinal.map(e => ({ e, ok: false }))]
    .map(x => ({ ...x, title: x.e.title, company: x.e.company, text: x.e.text })));
  const folded = new Set();
  for (const g of groups) {
    if (g.length < 2 || !g.some(x => x.ok)) continue;
    const keep = g.filter(x => x.ok).sort((a, b) =>
      SOURCE_RANK[info[a.e.idx].by.kind] - SOURCE_RANK[info[b.e.idx].by.kind] ||
      gradeRank(a.e.grade) - gradeRank(b.e.grade) || b.e.match.score - a.e.match.score ||
      trackPri[a.e.track] - trackPri[b.e.track])[0];
    keep.e.also_posted_by = g.filter(x => x !== keep).map(x => ({
      company: x.e.company, apply_url: x.e.ats, posted_by: info[x.e.idx].by.label,
    }));
    for (const x of g) if (x !== keep) folded.add(x.e);
  }
  const acceptedKept = acceptedFinal.filter(e => !folded.has(e));
  rejectedFinal = rejectedFinal.filter(e => !folded.has(e));

  // ── Build output ───────────────────────────────────────────────────────────

  const gradeCount = { A: 0, B: 0, C: 0 };
  const trackCount = Object.fromEntries(Object.keys(tracks).map(k => [k, 0]));
  const catCount   = {};

  const acceptedSorted = [...acceptedKept].sort((a, b) =>
    a.grade.localeCompare(b.grade) || b.match.score - a.match.score ||
    a.company.toLowerCase().localeCompare(b.company.toLowerCase())
  );

  const rolesOut = acceptedSorted.map(e => {
    gradeCount[e.grade] = (gradeCount[e.grade] || 0) + 1;
    trackCount[e.track] = (trackCount[e.track] || 0) + 1;
    catCount[e.role_cat] = (catCount[e.role_cat] || 0) + 1;
    const trackLabel = e.track in tracks ? `Track ${e.track} - ${tracks[e.track].label}` : `Track ${e.track}`;
    const notes = e.notes ? `${trackLabel}. ${e.notes}` : `${trackLabel}.`;
    const pd = e.posted_days;
    const posted = pd === null || pd === undefined ? 'Unknown' : pd < 1 ? 'Today' : `${Math.max(1, Math.round(pd))}d ago`;
    return {
      id:               e.jid,
      company:          e.company,
      location:         e.location,
      role_title:       e.title,
      role_cat:         e.role_cat,
      employment_type:  info[e.idx].emp,
      posted_by:        { kind: info[e.idx].by.kind, label: info[e.idx].by.label, reasons: info[e.idx].by.reasons },
      also_posted_by:   e.also_posted_by || [],
      target_company:   !!e.target_company,
      track:            e.track,
      work_type_bucket: e.work_type_eff,
      arrangement_uncertain: !!e.arrangement_uncertain,
      hybrid_days:      null,
      posted,
      posted_days:      pd ?? null,
      age_tier:         ageLabel(pd),
      salary:           e.salary,
      salary_unknown:   !e.salary,
      fit:              e.fit,
      grade:            e.grade,
      apply_url:        e.ats,
      match:            e.match,
      prescreen:        e.prescreen,
      flags:            e.flags,
      notes,
      addendum_note:    '',
    };
  });

  // Rejection categorization
  // Every reason above is a fixed phrase plus variable detail: a track key, a
  // company, a job title, a snippet of the posting, a location. Only the fixed
  // phrase is classified, because the detail is free text: matching words
  // anywhere would file a blocked company named "Staffing Geo Corp" as a geo
  // rule, or a job title containing "Salary" as a pay rejection.
  // Tier: 'tier1' = near miss (right kind of job, wrong terms or place);
  //       'tier2' = not a fit at all.
  const CAT_ORDER  = ['salary_floor','salary_missing','clearance','geo_restriction','travel','employment_type','blocked_title','domain_exclusion','repost','prescreen','grade_d','other'];
  const CAT_LABELS = {
    salary_floor:'Salary Below Floor', salary_missing:'Salary Not Listed', blocked_title:'Blocked Title Keyword',
    domain_exclusion:'Domain / Expertise Exclusion', geo_restriction:'Geographic Restriction',
    travel:'Travel Requirement', prescreen:'Pre-Screen Failure', clearance:'Clearance Required',
    grade_d:'Score Below Your Bar', employment_type:'Employment Type Not Accepted', repost:'Reposted Listing', other:'Other',
  };
  // [pattern on the fixed phrase, category, tier], first match wins.
  const REASON_RULES = [
    [/^salary required on this track/,               'salary_missing',   'tier1'],
    [/^salary /,                                     'salary_floor',     'tier1'],
    [/^security clearance required/,                 'clearance',        'tier1'],
    [/^geo: |^state-restricted remote/,              'geo_restriction',  'tier1'],
    [/^universal: travel /,                          'travel',           'tier1'],
    [/^universal: title does not match|^title does not match|^title matches no role this track accepts|blocked keyword in title|^(?:universal: )?blocked title keyword|^country indicator in title/,
                                                     'blocked_title',    'tier1'],
    [/^universal: blocked industry|^blocked industry on this track/, 'domain_exclusion', 'tier2'],
    [/^no listed industry in the posting/,           'domain_exclusion', 'tier1'],
    [/^universal: (?:requires .* experience|domain expertise required|domain experience required|experience bar too high)/,
                                                     'domain_exclusion', 'tier1'],
    [/^(?:full-time|contract|contract to hire|part-time|temporary|internship) roles not accepted on this track/,
                                                     'employment_type',  'tier1'],
    [/^universal: reposted by /,                     'repost',           'tier2'],
    [/^pre-screen: /,                                'prescreen',        'tier2'],
    [/^score |^grade [abc] below this track's bar/,  'grade_d',          'tier1'],
  ];

  function reasonPhrase(reason) {
    return String(reason || '')
      .replace(/^Track [^:]+:\s*/, '')          // track keys are user-defined
      .split(/\s+-\s+|\s+\(|\s+'/)[0]            // drop " - detail", " (detail)", " 'snippet'"
      .toLowerCase();
  }
  function classifyRej(reason) {
    const p = reasonPhrase(reason);
    for (const [re, cat, tier] of REASON_RULES) if (re.test(p)) return { cat, tier };
    return { cat: 'other', tier: 'tier1' };
  }
  function catRej(reason)  { return classifyRej(reason).cat; }
  function rejTier(reason) { return classifyRej(reason).tier; }

  const catCntRej = {};
  const rejRoles = rejectedFinal.sort((a, b) =>
    CAT_ORDER.indexOf(catRej(a.reason || '')) - CAT_ORDER.indexOf(catRej(b.reason || '')) ||
    a.company.toLowerCase().localeCompare(b.company.toLowerCase())
  ).map(e => {
    const cat = catRej(e.reason || '');
    catCntRej[cat] = (catCntRej[cat] || 0) + 1;
    const pd = e.posted_days;
    const posted = pd != null && pd >= 1 ? `${Math.round(pd)}d ago` : pd != null ? 'Today' : 'Unknown';
    return {
      id:               e.jid,
      company:          e.company,
      location:         e.location,
      role_title:       e.title,
      role_cat:         e.role_cat || 'Other',
      employment_type:  info[e.idx].emp,
      posted_by:        { kind: info[e.idx].by.kind, label: info[e.idx].by.label, reasons: info[e.idx].by.reasons },
      work_type_bucket: e.work_type_eff,
      posted, posted_days: pd ?? null,
      salary:           e.salary,
      salary_unknown:   !e.salary,
      apply_url:        e.ats,
      age_tier:         ageLabel(pd),
      reason:           e.reason,
      reason_cat:       cat,
      rejection_tier:   rejTier(e.reason || ''),
      notes:            e.notes,
      track:            e.track,
      match_pct:        e.match_pct,
    };
  });

  // What the scrape contained, before any filtering: every employment type and
  // kind of poster that came up, so nothing is hidden by the rules above.
  const tally = list => list.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
  const found = {
    employment_types: tally(info.map(x => x.emp)),
    posted_by:        tally(info.map(x => x.by.label)),
    same_job_folded:  folded.size,
  };
  const foundStr = list => Object.entries(list).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ');

  // Summary
  const nTarget  = acceptedKept.filter(e => e.target_company).length;
  const rejRate  = Math.round(rejectedFinal.length * 100 / (allResults.length || 1));
  const trackParts = Object.entries(tracks).map(([k, t]) => `${trackCount[k] || 0} ${t.label} (${k})`);
  const trackStr = trackParts.length === 1 ? trackParts[0]
    : trackParts.length === 2 ? trackParts.join(' and ')
    : trackParts.slice(0, -1).join(', ') + ', and ' + trackParts[trackParts.length - 1];

  const keyObs = [
    `Scan (${scanLabel}) of ${allResults.length} listings yielded ${gradeCount.A || 0} Grade-A, ${gradeCount.B || 0} Grade-B, and ${gradeCount.C || 0} Grade-C roles (${rejRate}% rejected).`,
    `By track: ${trackStr}.`,
    nTarget ? `${nTarget} accepted role${nTarget > 1 ? 's' : ''} at target companies.` : `No target company roles accepted (${scanLabel.toLowerCase()}).`,
    `The scrape held ${foundStr(found.employment_types)} roles, posted by: ${foundStr(found.posted_by)}.`,
    found.same_job_folded ? `${found.same_job_folded} duplicate postings of the same job were folded into one listing each.` : '',
  ].filter(Boolean).join(' ');

  const locParts = ['United States (Remote)'];
  for (const [, t] of Object.entries(tracks)) {
    if (t.target_location) locParts.push(t.target_location + (t.target_radius_mi ? ` ${t.target_radius_mi}mi` : ''));
  }
  const locationsStr = [...new Map(locParts.map(l => [l, l])).values()].join(' + ');

  console.log(`\n  Eval complete: ${rolesOut.length} accepted, ${rejRoles.length} rejected`);

  return {
    accepted: {
      meta: {
        date: today, time: scrapeTime, search_term: searchTerm, locations: locationsStr,
        qualifying_count: acceptedKept.length, reviewed_count: allResults.length,
        total_results: allResults.length,
        grade_a: gradeCount.A || 0, grade_b: gradeCount.B || 0, grade_c: gradeCount.C || 0,
        excluded_count: rejectedFinal.length,
        track_counts: trackCount, cat_counts: catCount, found,
        top_a_companies: [],
        key_observation: keyObs,
        track_labels: Object.fromEntries(Object.entries(tracks).map(([k, t]) => [k, t.label])),
        track_locations: Object.fromEntries(Object.entries(tracks).filter(([, t]) => t.target_location).map(([k, t]) => [k, t.target_location])),
      },
      roles: rolesOut,
    },
    rejected: {
      meta: {
        date: today, time: scrapeTime, search_term: searchTerm,
        total_raw: allResults.length, total_accepted: acceptedKept.length, total_rejected: rejectedFinal.length,
        ...Object.fromEntries(CAT_ORDER.map(c => [`${c}_count`, catCntRej[c] || 0])),
        key_observation: `${rejectedFinal.length} listings excluded. ` +
          CAT_ORDER.filter(c => catCntRej[c]).map(c => `${CAT_LABELS[c]} (${catCntRej[c]})`).join(', ') + '.',
      },
      roles: rejRoles,
      cat_labels: CAT_LABELS,
      cat_order:  CAT_ORDER,
    },
  };
}

module.exports = { run };
