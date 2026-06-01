'use strict';

/**
 * src/eval.js
 * Port of eval_jobs.py — scoring engine.
 * run(mergePayload, cfg) -> evaluated JSON object matching HANDOFF §4 output format.
 * Async because geo-checking requires network calls (Nominatim API with local cache).
 */

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');

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
      headers: { 'User-Agent': 'Jobsift-electron/0.1 (job search automation)' },
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
 * Mirrors geo_utils.multi_within_radius().
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

// ── Grade helpers ─────────────────────────────────────────────────────────────

function grade(score, track) {
  if (score >= track.grade_a) return 'A';
  if (score >= track.grade_b) return 'B';
  if (score >= track.grade_c) return 'C';
  return 'D';
}

function applyAgeCap(g, days) {
  if (days === null || days === undefined) return [g, null];
  let cap = null, label = null;
  if (days > 30)      { cap = 'C'; label = `${Math.floor(days)}d old - capped to C`; }
  else if (days > 21) { cap = 'B'; label = `${Math.floor(days)}d old - capped to B`; }
  else return [g, null];
  const order = ['A', 'B', 'C', 'D'];
  if (order.indexOf(g) < order.indexOf(cap)) return [cap, label];
  return [g, null];
}

// ── Scoring tier helpers ──────────────────────────────────────────────────────

function scoreTiers(text, tiers) {
  const lower = (text || '').toLowerCase();
  for (const tier of (tiers || [])) {
    if ('default' in tier) return tier.default;
    if ((tier.keywords || []).some(kw => lower.includes(kw.toLowerCase()))) return tier.score;
  }
  return 1;
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

// ── Role category ─────────────────────────────────────────────────────────────

function roleCategory(title, roleCategories) {
  const t = (title || '').toLowerCase();
  for (const cat of (roleCategories || [])) {
    if ((cat.keywords || []).some(kw => t.includes(kw.toLowerCase()))) return cat.label;
  }
  return roleCategories?.length ? roleCategories[roleCategories.length - 1].label : 'Other';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * run(mergePayload, cfg) -> evaluated output object
 * mergePayload: { results: [], scan_label, date, days_ago }
 * cfg: parsed config.json
 */
async function run(mergePayload, cfg) {
  const resultsRaw  = mergePayload.results || [];
  const scanLabel   = mergePayload.scan_label || 'This scan';
  const today       = mergePayload.date || new Date().toISOString().slice(0, 10);
  const searchTerm  = cfg.pipeline?.search_term || '';
  const roleCats    = cfg.role_categories?.categories || [{ label: 'Other', keywords: [] }];

  // Build tracks map (ordered)
  const tracks = {};
  for (const t of (cfg.tracks || [])) tracks[t.key] = t;
  const trackPri = Object.fromEntries(Object.keys(tracks).map((k, i) => [k, i]));

  // Synthetic copies from pipeline.generate_copies
  const genCopies = cfg.pipeline?.generate_copies || {};
  const synthCopies = [];
  for (const r of resultsRaw) {
    const srcPass = r.search_pass || '';
    if (srcPass in genCopies) {
      synthCopies.push({ ...r, search_pass: genCopies[srcPass] });
    }
  }
  const allResults = [...resultsRaw, ...synthCopies];
  console.log(`  ${allResults.length} listings to evaluate (${synthCopies.length} synthetic copies)`);

  // ── Pre-build regexes ──────────────────────────────────────────────────────

  const rf          = cfg.rejection_filters  || {};
  const titleFilt   = cfg.title_filters      || {};
  const compLists   = cfg.company_lists      || {};
  const domainScor  = cfg.domain_scoring     || {};
  const scoring     = cfg.scoring            || {};

  const TITLE_REQUIRE_RE     = buildRe(titleFilt.title_require     || []);
  const TITLE_BLOCK_RE       = buildRe(titleFilt.title_block       || []);
  const BLOCKED_INDUSTRIES_RE = buildRe(rf.blocked_industries      || []);
  const BLOCKED_COMPANIES_RE  = buildRe(compLists.blocked_companies || []);
  const BLOCKED_AGENCIES_RE   = buildRe(compLists.blocked_agencies  || []);
  const TARGET_COMPANIES_RE   = buildRe(compLists.target_companies  || []);
  const DESCRIPTION_BLOCKER_RE = buildRe(rf.description_blockers   || []);

  const D3_TIERS = {
    5: buildRe(domainScor.tier5 || []),
    4: buildRe(domainScor.tier4 || []),
    3: buildRe(domainScor.tier3 || []),
    2: buildRe(domainScor.tier2 || []),
  };

  const DOMAIN_EXP_INDS = rf.domain_experience_industries || [];
  const domIndPat = DOMAIN_EXP_INDS.length
    ? DOMAIN_EXP_INDS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    : null;
  const YEARS_IN_DOMAIN  = domIndPat ? new RegExp(`\\b(\\d+)(?:\\+|\\s*to\\s*\\d+)?\\s*years?\\s+(?:of\\s+)?(?:experience\\s+)?(?:in|within|working\\s+in)\\s+(?:the\\s+)?(?:${domIndPat})\\b`, 'i') : null;
  const DOMAIN_KNOW_REQ  = domIndPat ? new RegExp(`\\b(?:${domIndPat})\\s+(?:domain\\s+)?(?:knowledge|expertise|experience|background)\\s+(?:is\\s+)?(?:required|must|necessary|mandatory|essential)\\b`, 'i') : null;
  const DOMAIN_EXP_IN    = domIndPat ? new RegExp(`\\bexperience\\s+(?:in|with|within|working\\s+in)\\s+(?:the\\s+)?(?:${domIndPat})(?:\\s+(?:industry|sector|space|market|domain|environment))?\\b`, 'i') : null;
  const DOMAIN_EXP_REV   = domIndPat ? new RegExp(`\\b(?:${domIndPat})\\s+experience\\b`, 'i') : null;

  const maxExpYrs = rf.max_experience_years || 10;
  const expNums   = Array.from({ length: 31 - maxExpYrs }, (_, i) => maxExpYrs + i).join('|');
  const HIGH_EXP_BAR = new RegExp(
    `\\b(${expNums})\\+?\\s*years?[''s]?\\s+(?:of\\s+)?(?:(?:relevant|related|progressive|professional|combined)\\s+)?(?:experience|program\\s+management|project\\s+management|implementing|managing)\\b` +
    `|\\b(?:minimum(?:\\s+of)?|a\\s+minimum\\s+of|over|at\\s+least)\\s+(${expNums})\\s*\\+?\\s*years?\\b`,
    'i',
  );

  const CLEARANCE_REQ   = /\b(secret clearance|top secret|ts\/sci|active clearance|security clearance required|clearance required)\b/i;
  const CLEARANCE_OBTAIN = /\b(?:ability|eligible|must be able|willing|can)\s+to\s+obtain\b.{0,60}clearance|clearance.{0,60}\b(?:ability|eligible|must be able|willing|can)\s+to\s+obtain\b/i;
  const TRAVEL_PCT_RE   = /(\d{1,3})\s*%\s*(?:domestic\s+|international\s+)?travel|travel\s+(?:up\s+to|of|required|expected)?\s*(\d{1,3})\s*%|travel\s+(?:requirement|required)[^\d]{0,10}(\d{1,3})\s*%/gi;
  const TRAVEL_HEAVY    = /\b(extensive travel|heavy travel|frequent travel|significant travel|up to 75%|up to 50%|50% travel|75% travel)\b/i;
  const DISGUISED_HYBRID = /\b([2-5]|two|three|four|five)\s*(?:[-–]\s*\d+)?\s*days?\s+(?:a|per)\s+week\s*(?:in\s*(?:the\s*)?(?:office|person|site|building))?|(?:in[\s\-]?(?:office|person|site))\s+(?:[2-5]|two|three|four|five)\s+days?\s+(?:a|per)\s+week|(?:on[\s\-]?site|in[\s\-]?office)\s+(?:presence|requirement|days?)[^.]{0,40}(?:\bweek(?:ly)?\b)/i;
  const DISGUISED_INPERSON = /(?:this\s+)?(?:role|position|job)\s+is\s+(?:fully\s+)?(?:on[\s\-]?site|in[\s\-]?person)|(?:must|required\s+to)\s+be\s+(?:on[\s\-]?site|in[\s\-]?person|in\s+(?:the\s+)?office)|100\s*%\s*(?:on[\s\-]?site|in[\s\-]?person)|fully\s+(?:on[\s\-]?site|in[\s\-]?person)(?!\s+interview)|not\s+(?:eligible|available)\s+for\s+remote|no\s+remote\s+(?:work\s+)?(?:option|available|allowed|offered)|(?:local|in[\s\-]?person)\s+candidates?\s+only/i;
  const ONE_DAY_HYBRID  = /\b1\s+day\s+(?:a|per)\s+week|one\s+day\s+(?:a|per)\s+week|(?:in[\s\-]?(?:office|person|site))\s+1\s+day\s+(?:a|per)\s+week|once\s+(?:a|per)\s+week\s+in\s+(?:the\s+)?(?:office|person)/i;
  const REMOTE_NON_USA  = /\b(global|worldwide|world[.\-\s]?wide|anywhere|international|emea|apac|latam|united\s+kingdom|england|uk\b|ireland|dublin|canada|toronto|vancouver|montreal|ottawa|calgary|edmonton|germany|berlin|munich|france|paris|netherlands|amsterdam|spain|madrid|italy|milan|rome|sweden|stockholm|switzerland|zurich|belgium|brussels|portugal|lisbon|australia|sydney|melbourne|india|bangalore|bengaluru|mumbai|hyderabad|pune|chennai|japan|tokyo|south\s+korea|seoul|china|beijing|shanghai|shenzhen|singapore|israel|tel\s+aviv|dubai|uae|brazil|s[aã]o\s+paulo|argentina|buenos\s+aires|colombia)\b/i;
  const IRL_INTERNATIONAL = /\b(united\s+kingdom|england|wales|scotland|northern\s+ireland|netherlands|holland|amsterdam|japan|tokyo|osaka|south\s+korea|republic\s+of\s+korea|seoul|united\s+arab\s+emirates|abu\s+dhabi|dubai|israel|tel\s+aviv|germany|france|spain|italy|australia|singapore|india)\b/i;
  const FACILITY_CODE_RE = /(?:[A-Z]{1,4}\s*[-:]\s*\d{3,}|store\s+support\s+cent(?:er|re)|distribution\s+cent(?:er|re)|fulfillment\s+cent(?:er|re)|warehouse\s+\d)/i;
  const REMOTE_WORK_SIGNAL = /\b(?:fully|completely|100\s*%|entirely)[\s\-]+remote\b|\bremote[\s\-]+(?:first|only|position|role|job|opportunity|eligible|work|option|friendly)\b|\bwork(?:ing)?[\s\-]+(?:from[\s\-]+home|remotely)\b|\b(?:telecommut|wfh)\b|\bthis\s+(?:role|position|job)\s+is\s+remote\b|\beligible\s+for\s+remote\b|\bremote\s+work\s+(?:is\s+)?(?:available|allowed|supported|offered)\b|\bwork\s+from\s+anywhere\b|\bno\s+office\s+requirement\b|\bremote\s+employees?\b|\bcategorized\s+as\s+(?:a\s+)?remote\b|\bwork\s+from\s+(?:home|anywhere\b|a\s+physical\s+location)|\bno\s+permanent\s+(?:corporate\s+)?office\b/i;
  const LOC_REMOTE_OPTION = /\bremote\s+within\b|\bor\s+remote\b|^\s*(?:united\s+states(?:\s+of\s+america)?|u\.s\.a?|usa?|north\s+america)\s*$/i;
  const WORKDAY_STATE   = /\/Remote-([A-Z]{2})(?:\/|$)/i;
  const REMOTE_STATE_LOC = /\bRemote[-–,]\s*[A-Z]{2}\b|\bRemote\s+[A-Z]{2}\b/g;
  const MUST_RESIDE     = /\bmust\s+(?:be\s+)?(?:reside|located|live|be\s+based)\s+(?:in|out\s+of|within)\b/i;
  const TITLE_COUNTRY   = /\(\s*(?:uk|eu|uae|isr|japan|south\s+korea|korea|israel|netherlands)\s*\)|\b(?:south\s+korea|japan|uae|israel)\s*$|-\s*(?:uk|eu|uae|japan|south\s+korea)\b/i;

  // Per-track compiled regexes
  const trackExclRe   = {};
  const trackTargetRe = {};
  const trackTitleReqRe = {};
  const trackTitleBlkRe = {};
  const trackLevelCapRe = {};
  for (const [tid, t] of Object.entries(tracks)) {
    trackExclRe[tid]     = buildRe(t.excluded_companies || []);
    trackTargetRe[tid]   = buildRe(t.target_companies   || []);
    trackTitleReqRe[tid] = (t.title_require || []).length ? buildRe(t.title_require) : null;
    trackTitleBlkRe[tid] = buildRe(t.title_block || []);
    trackLevelCapRe[tid] = (t.level_cap_b || []).length ? buildRe(t.level_cap_b) : null;
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

  const acceptedRaw = [];
  const rejectedRaw = [];
  const hybridWarnings = [];

  function univRej(jid, idx, title, company, salary, wt, wbEff, loc, pct, postedDays, reason, notes, ats, sp) {
    const firstTrack = Object.keys(tracks)[0] || '';
    rejectedRaw.push({
      jid, idx, track: firstTrack, company, title, salary,
      work_type: wt, work_type_eff: wbEff, location: loc,
      match_pct: pct, posted_days: postedDays,
      reason, notes, ats, sp, role_cat: roleCategory(title, roleCats),
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

  function d3Score(text) {
    for (const tier of [5, 4, 3, 2]) {
      if (D3_TIERS[tier].test(text)) return tier;
    }
    return 1;
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

  // ── Pre-batch geocoding ────────────────────────────────────────────────────
  // Collect every unique non-remote location that will need a radius check and
  // geocode them upfront before the eval loop. This deduplicates locations across
  // roles and tracks so each unique string is only geocoded once even when the
  // same city appears in hundreds of listings. The eval loop then hits only the
  // warm in-memory cache — no per-role network round trips.
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
      // geocode() checks cache first — only hits network for new entries
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

    // Mislabeled in-person: remote-tagged but location is a specific city
    let wtMut = wt;
    const locLead = loc && loc.includes(',') ? loc.split(',')[0].trim() : loc;
    if (/remote/i.test(wt) && loc &&
        !/\b(remote|united\s+states?|usa|anywhere|worldwide|nationwide|virtual|wfh|work\s+from\s+home)\b/i.test(locLead) &&
        !/\bremote\b/i.test(allText + ' ' + title)) {
      wtMut = 'Onsite';
    }

    const locDisplay = loc || (/remote/i.test(wtMut) ? 'Remote - US' : 'USA');
    let wb  = wtBucket(wtMut);
    const locOffersRemote = LOC_REMOTE_OPTION.test(loc || '');
    let wbEff = locOffersRemote ? 'remote' : wb;
    if (wbEff === 'hybrid' && REMOTE_WORK_SIGNAL.test(resps + ' ' + req + ' ' + pref)) {
      wbEff = 'remote';
    }

    // ── Universal hard disqualifiers ────────────────────────────────────────
    let done = false;

    if (!resps && !req && !pref) {
      univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,'Universal: No job description available - returned empty content','',ats,sp);
      done = true;
    }
    if (!done && TITLE_REQUIRE_RE.source !== '(?!)' && !TITLE_REQUIRE_RE.test(title)) {
      univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,'Universal: Title does not match required keywords','',ats,sp);
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
        univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Requires ${myr[1]}+ yrs non-tech domain experience - '${myr[0].slice(0, 70)}'`,'',ats,sp);
        done = true;
      }
    }
    if (!done && DOMAIN_KNOW_REQ) {
      const mkn = DOMAIN_KNOW_REQ.exec(req);
      if (mkn) { univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Non-tech domain expertise required - '${mkn[0].slice(0,70)}'`,'',ats,sp); done = true; }
    }
    if (!done && DOMAIN_EXP_IN) {
      const mei = DOMAIN_EXP_IN.exec(req);
      if (mei) { univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Domain experience required - '${mei[0].slice(0,80)}'`,'',ats,sp); done = true; }
    }
    if (!done && DOMAIN_EXP_REV) {
      const mer = DOMAIN_EXP_REV.exec(req);
      if (mer) { univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Domain experience required - '${mer[0].slice(0,80)}'`,'',ats,sp); done = true; }
    }
    if (!done) {
      const mexp = HIGH_EXP_BAR.exec(req + ' ' + resps.slice(0, 300));
      if (mexp) { univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Experience bar too high - '${mexp[0].slice(0,70)}'`,'',ats,sp); done = true; }
    }
    if (!done) {
      const tp = travelPct(allText);
      if (tp !== null && tp > (rf.max_travel_pct || 25)) {
        univRej(jid,idx,title,company,salary,wtMut,wbEff,locDisplay,pct,postedDays,`Universal: Travel ${tp}% exceeds ${rf.max_travel_pct}% threshold`,'',ats,sp);
        done = true;
      }
    }
    if (done) continue;

    // ── Per-track evaluation ─────────────────────────────────────────────────
    const trackRejs = {};
    let accepted = false;

    for (const [trackId, track] of Object.entries(tracks)) {
      let locCaOnly    = false;
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
            locCaOnly = true;
          } else if (IRL_INTERNATIONAL.test(locDisplay)) {
            trackRejs[trackId] = `Geo: International location (${locDisplay})`; continue;
          } else if (FACILITY_CODE_RE.test(locDisplay)) {
            trackRejs[trackId] = `Geo: Location is a facility/store code (${locDisplay})`; continue;
          } else {
            const radius = track.target_radius_mi ?? 0;
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

      // ── Disguised hybrid/in-person ─────────────────────────────────────────
      if (wbEff === 'remote' && !acceptedWt.has('hybrid')) {
        const descBlob = resps + ' ' + req;
        const mHybrid = DISGUISED_HYBRID.exec(descBlob);
        const mInprsn = DISGUISED_INPERSON.exec(descBlob);
        if (mHybrid) {
          const snippet = mHybrid[0].slice(0, 60);
          hybridWarnings.push(`${company} - ${title}: disguised hybrid '${snippet}'`);
          trackRejs[trackId] = `Track ${trackId}: Disguised hybrid - '${snippet}'`; continue;
        }
        if (mInprsn) {
          const snippet = mInprsn[0].slice(0, 60);
          hybridWarnings.push(`${company} - ${title}: disguised in-person '${snippet}'`);
          trackRejs[trackId] = `Track ${trackId}: Disguised in-person - '${snippet}'`; continue;
        }
        const locSignalsRemote = /\bremote\b/i.test(locDisplay || '') || locOffersRemote;
        if (!locSignalsRemote && !REMOTE_WORK_SIGNAL.test(resps + ' ' + req + ' ' + title)) {
          trackRejs[trackId] = `Track ${trackId}: Remote-tagged but no remote-work language in JD - likely mislabeled (${locDisplay || 'no location'})`; continue;
        }
      }

      // ── Per-track company/title filters ────────────────────────────────────
      if (trackExclRe[trackId].test(company)) {
        trackRejs[trackId] = `Track ${trackId}: Excluded company - ${company}`; continue;
      }
      if (trackTitleBlkRe[trackId].test(title)) {
        trackRejs[trackId] = `Track ${trackId}: Per-track blocked keyword in title - ${title}`; continue;
      }
      const ptReq = trackTitleReqRe[trackId];
      if (ptReq && !ptReq.test(title)) {
        trackRejs[trackId] = `Track ${trackId}: Title does not match per-track required keyword - ${title}`; continue;
      }

      // ── Seniority gates ────────────────────────────────────────────────────
      const levelCapped = trackLevelCapRe[trackId]?.test(title) ?? false;
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
      const clearancePresent = CLEARANCE_REQ.test(allText) || CLEARANCE_OBTAIN.test(allText);
      if (clearancePresent && track.clearance_behavior === 'reject') {
        trackRejs[trackId] = `Track ${trackId}: Security clearance required`; continue;
      }
      const clearanceFlagged = clearancePresent && track.clearance_behavior === 'flag';

      // ── Salary gate ────────────────────────────────────────────────────────
      if (noSalary && track.reject_if_no_salary) {
        trackRejs[trackId] = `Track ${trackId}: Salary required on this track - not disclosed`; continue;
      }

      const isPrestige = TARGET_COMPANIES_RE.test(company) || trackTargetRe[trackId].test(company);
      const salFloor   = isPrestige ? (track.salary_floor - (track.wiggle_room || 0)) : track.salary_floor;

      if (track.reject_if_max_below != null && hi !== null && hi < track.reject_if_max_below) {
        trackRejs[trackId] = `Track ${trackId}: Salary ceiling $${Math.floor(hi/1000)}K below $${Math.floor(track.reject_if_max_below/1000)}K minimum`; continue;
      }
      if (mid !== null && mid < salFloor) {
        trackRejs[trackId] = `Track ${trackId}: Salary midpoint $${(mid/1000).toFixed(0)}K below $${(salFloor/1000).toFixed(0)}K floor`; continue;
      }

      // ── Geo restriction in description ────────────────────────────────────
      const geoRej = checkGeoRestriction(locDisplay, ats, card, resps + ' ' + req);
      if (geoRej) { trackRejs[trackId] = `Track ${trackId}: ${geoRej}`; continue; }

      // ── Scoring ───────────────────────────────────────────────────────────
      const d3 = d3Score(allText);
      if (track.min_domain_score != null && d3 < track.min_domain_score) {
        trackRejs[trackId] = `Track ${trackId}: Domain D3=${d3} below minimum ${track.min_domain_score}`; continue;
      }

      const d1 = scoreTiers(title,          scoring.title_tiers        || []);
      const d2 = scoreTiers(resps + ' ' + title, scoring.scope_tiers   || []);
      const d4 = scoreTiers(req,             scoring.requirement_tiers  || []);

      // D5: salary competitiveness
      let d5, salNote;
      if (noSalary || mid === null) {
        d5 = 1; salNote = 'Salary not listed';
      } else if (mid >= track.salary_score_5) { d5 = 5; salNote = `$${(mid/1000).toFixed(0)}K mid`; }
      else if (mid >= track.salary_score_4)   { d5 = 4; salNote = `$${(mid/1000).toFixed(0)}K mid`; }
      else if (track.salary_score_3 != null && mid >= track.salary_score_3) { d5 = 3; salNote = `$${(mid/1000).toFixed(0)}K mid`; }
      else                                    { d5 = 2; salNote = `$${(mid/1000).toFixed(0)}K mid`; }

      // D6: work arrangement fit
      const wbEffSet = new Set((track.work_types || []).map(w => w.toLowerCase()));
      let d6;
      if (wbEff === 'remote')    d6 = 5;
      else if (wbEff === 'in-person') d6 = wbEffSet.has('onsite') ? 5 : 3;
      else                       d6 = 4;   // hybrid

      const w = track.score_weights || { d1:1, d2:1, d3:1, d4:1, d5:1 };
      const scoreVal = d1*(w.d1||1) + d2*(w.d2||1) + d3*(w.d3||1) + d4*(w.d4||1) + d5*(w.d5||1);
      let fit = grade(scoreVal, track);
      if (fit === 'D') { trackRejs[trackId] = `Track ${trackId}: Score ${scoreVal.toFixed(2)} - Grade D`; continue; }

      if (levelCapped && fit === 'A') fit = 'B';
      const domainCap = track.domain_cap_at != null && d3 <= track.domain_cap_at && ['A','B'].includes(fit);
      if (domainCap) fit = 'C';

      const [finalGrade, ageCapReason] = applyAgeCap(fit, postedDays);

      // ── Flags and notes ───────────────────────────────────────────────────
      const flags = [], notesList = [];
      if (locCaOnly)      flags.push('Location is California only - confirm it is within commute range');
      if (locGeoUnknown)  flags.push('Location could not be verified - confirm it is within commute range');
      if (BLOCKED_AGENCIES_RE.test(company)) flags.push('Agency-sourced - verify direct posting');
      if (isPrestige)     flags.push('Target company');
      if (clearanceFlagged) flags.push('Clearance required - verify compensation justifies it');
      if (levelCapped)    flags.push('Level-capped title - grade capped at B');
      if (noSalary && !track.reject_if_no_salary) flags.push(`Salary not disclosed - cannot verify $${Math.floor(track.salary_floor/1000)}K floor`);
      if (ageCapReason)   notesList.push(ageCapReason);
      if (noSalary)       notesList.push('Salary not listed');
      const tp = travelPct(allText);
      if (tp)             notesList.push(`${tp}% travel noted`);
      if (wbEff === 'hybrid') notesList.push('Hybrid work arrangement');
      if (domainCap)      notesList.push(`Domain cap -> C (D3=${d3})`);
      if (isPrestige && mid !== null && mid < track.salary_floor) notesList.push(`Salary $${(mid/1000).toFixed(0)}K - prestige buffer applied`);

      const prescreen = {
        title:       { pass: true,  note: 'Title accepted' },
        arrangement: { pass: true,  note: `Work arrangement: ${wbEff} accepted on ${track.label}` },
        salary:      {
          pass: !(noSalary && track.reject_if_no_salary),
          note: noSalary
            ? `Salary not disclosed - verify $${Math.floor(track.salary_floor/1000)}K floor before applying`
            : `Salary ${salNote} meets $${Math.floor(track.salary_floor/1000)}K floor`,
        },
      };
      if (d3 <= 1) prescreen.domain = { pass: false, note: `Domain D3=${d3} - non-tech sector` };
      else if (d3 >= 4) prescreen.domain = { pass: true, note: `Domain D3=${d3} - software` };

      acceptedRaw.push({
        jid, idx, track: trackId, role_cat: roleCategory(title, roleCats),
        company, title, salary, work_type: wtMut, work_type_eff: wbEff,
        location: locDisplay, match_pct: pct, posted_days: postedDays,
        d1, d2, d3, d4, d5, d6, score: Math.round(scoreVal * 100) / 100,
        fit, grade: finalGrade, prescreen, flags, notes: notesList.join('; '),
        ats, sp,
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
        reason: primaryRej, notes: allRejNotes, ats, sp,
        role_cat: roleCategory(title, roleCats),
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
  const rejectedFinal = Object.values(rejByKey);

  // ── Build output ───────────────────────────────────────────────────────────

  const gradeCount = { A: 0, B: 0, C: 0 };
  const trackCount = Object.fromEntries(Object.keys(tracks).map(k => [k, 0]));
  const catCount   = {};

  const acceptedSorted = [...acceptedFinal].sort((a, b) =>
    a.grade.localeCompare(b.grade) || a.company.toLowerCase().localeCompare(b.company.toLowerCase())
  );

  const rolesOut = acceptedSorted.map(e => {
    gradeCount[e.grade] = (gradeCount[e.grade] || 0) + 1;
    trackCount[e.track] = (trackCount[e.track] || 0) + 1;
    catCount[e.role_cat] = (catCount[e.role_cat] || 0) + 1;
    const dims = Object.fromEntries(['d1','d2','d3','d4','d5','d6'].map(k => [k, { score: e[k], rationale: '' }]));
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
      track:            e.track,
      work_type_bucket: e.work_type_eff,
      hybrid_days:      null,
      posted,
      posted_days:      pd ?? null,
      age_tier:         ageLabel(pd),
      salary:           e.salary,
      salary_unknown:   !e.salary,
      fit:              e.fit,
      grade:            e.grade,
      apply_url:        e.ats,
      weighted_score:   e.score,
      d6_cap:           null,
      age_cap:          null,
      dimensions:       dims,
      prescreen:        e.prescreen,
      flags:            e.flags,
      notes,
      addendum_note:    '',
    };
  });

  // Rejection categorization
  const CAT_ORDER  = ['salary_floor','clearance','geo_restriction','travel','title_level','blocked_title','domain_exclusion','prescreen','grade_d','other'];
  const CAT_LABELS = {
    salary_floor:'Salary Below Floor', title_level:'Title Level Mismatch',
    blocked_title:'Blocked Title Keyword', domain_exclusion:'Domain / Expertise Exclusion',
    geo_restriction:'Geographic Restriction', travel:'Travel Requirement',
    prescreen:'Pre-Screen Failure', clearance:'Clearance / Competitor Conflict',
    grade_d:'Grade D (Low Score)', other:'Other',
  };
  const TIER2_SIGS = ['title level','too senior','director','vp ','staff','principal','internship','unpaid','pre-screen','ic depth','check 1','check 2','blocked industry','physical-world','d3=1','irrelevant domain'];
  const TIER1_SIGS = ['salary','tc midpoint','tc ceiling','no salary','state-restricted','geo','travel','clearance','competitor','experience bar','disguised hybrid'];

  function catRej(reason) {
    const r = reason.toLowerCase();
    if (/salary|tc ceiling|tc midpoint|no salary/.test(r)) return 'salary_floor';
    if (/staff|principal|director|vp |too senior|internship|unpaid/.test(r)) return 'title_level';
    if (/(blocked.*title|title.*keyword|title.*required|country.*title)/.test(r)) return 'blocked_title';
    if (/domain|blocked industry|experience bar/.test(r)) return 'domain_exclusion';
    if (/state-restricted|geo/.test(r)) return 'geo_restriction';
    if (/travel/.test(r)) return 'travel';
    if (/pre-screen|check 1|check 2|ic depth/.test(r)) return 'prescreen';
    if (/clearance|competitor/.test(r)) return 'clearance';
    if (/grade d|score/.test(r)) return 'grade_d';
    return 'other';
  }

  function rejTier(reason) {
    const r = reason.toLowerCase();
    if (TIER2_SIGS.some(s => r.includes(s))) return 'tier2';
    if (TIER1_SIGS.some(s => r.includes(s))) return 'tier1';
    return 'tier1';
  }

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

  // Summary
  const nTarget  = acceptedFinal.filter(e => e.flags?.some(f => f.includes('Target company'))).length;
  const rejRate  = Math.round(rejectedFinal.length * 100 / (allResults.length || 1));
  const trackParts = Object.entries(tracks).map(([k, t]) => `${trackCount[k] || 0} ${t.label} (${k})`);
  const trackStr = trackParts.length === 1 ? trackParts[0]
    : trackParts.length === 2 ? trackParts.join(' and ')
    : trackParts.slice(0, -1).join(', ') + ', and ' + trackParts[trackParts.length - 1];

  const keyObs = [
    `Scan (${scanLabel}) of ${allResults.length} listings yielded ${gradeCount.A || 0} Grade-A, ${gradeCount.B || 0} Grade-B, and ${gradeCount.C || 0} Grade-C roles (${rejRate}% rejected).`,
    `By track: ${trackStr}.`,
    nTarget ? `${nTarget} accepted role${nTarget > 1 ? 's' : ''} at target companies.` : `No target company roles accepted (${scanLabel.toLowerCase()}).`,
  ].join(' ');

  const locParts = ['United States (Remote)'];
  for (const [, t] of Object.entries(tracks)) {
    if (t.target_location) locParts.push(t.target_location + (t.target_radius_mi ? ` ${t.target_radius_mi}mi` : ''));
  }
  const locationsStr = [...new Map(locParts.map(l => [l, l])).values()].join(' + ');

  console.log(`\n  Eval complete: ${rolesOut.length} accepted, ${rejRoles.length} rejected`);

  return {
    accepted: {
      meta: {
        date: today, search_term: searchTerm, locations: locationsStr,
        qualifying_count: acceptedFinal.length, reviewed_count: allResults.length,
        total_results: allResults.length,
        grade_a: gradeCount.A || 0, grade_b: gradeCount.B || 0, grade_c: gradeCount.C || 0,
        excluded_count: rejectedFinal.length,
        track_counts: trackCount, cat_counts: catCount,
        top_a_companies: [],
        key_observation: keyObs,
        track_labels: Object.fromEntries(Object.entries(tracks).map(([k, t]) => [k, t.label])),
        track_locations: Object.fromEntries(Object.entries(tracks).filter(([, t]) => t.target_location).map(([k, t]) => [k, t.target_location])),
      },
      roles: rolesOut,
    },
    rejected: {
      meta: {
        date: today, search_term: searchTerm,
        total_raw: allResults.length, total_accepted: acceptedFinal.length, total_rejected: rejectedFinal.length,
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
