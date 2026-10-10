'use strict';

/**
 * src/criteria.js
 * What the user is looking for, how a job is scored against it, and the
 * one-time move of an older config to this layout.
 *
 * A job's match score is out of 100, built from four signals:
 *
 *   Title     the most specific listed role found in the job title
 *               Ideal 40, Good 30, Acceptable 20
 *   Pay       the posted salary against the track's pay levels: ideal pay and
 *             good pay (by default 30% and 15% over the floor) and the floor
 *               top 20, good 15, at floor 10, below floor or not listed 5
 *   Industry  a listed industry found anywhere in the posting
 *               Strong 20, Some 10
 *   Skills    listed words found in the posting
 *               5 each, up to 20 (or 5 x the list, if shorter)
 *
 * A signal the user has not set up (no roles, no industries, no skills, no pay
 * floor) is left out, and the score is taken over the signals that remain, so
 * an unused signal never counts against a job.
 *
 * Grades: A from 80, B from 65, C from 50. Below 50 is not a match. Each track
 * accepts A only, A and B, or A to C. A posting older than the
 * settings.stale_after_days limit is shown one grade lower (never below C).
 *
 * Config layout (config_version 3):
 *   roles:      [{ title, priority: 'ideal' | 'good' | 'acceptable' }]
 *   industries: [{ name, strength: 'strong' | 'some' }]
 *   skills:     [string]
 *   tracks[]:   accept_grades 'A' | 'AB' | 'ABC', industry_required,
 *               salary_floor, pay_top, pay_good (blank = derived)
 *   tracks[]:   employment_types [] (empty = every type; "Not stated" always passes)
 *   settings:   stale_after_days (blank = never lower a grade)
 *   sources:    see sources.js; company_lists.staffing_firms
 *
 * No Electron dependency, so this module can be tested directly with node.
 */

const { DEFAULT_SOURCES, EMPLOYMENT_TYPES, NOT_STATED, POSTED_BY } = require('./sources');

const CONFIG_VERSION = 3;

const PRIORITY_POINTS = { ideal: 40, good: 30, acceptable: 20 };
const STRENGTH_POINTS = { strong: 20, some: 10 };
const PAY_POINTS = { top: 20, good: 15, floor: 10, below: 5 };
const SKILL_POINTS = 5;
const MAX = { Title: 40, Pay: 20, Industry: 20, Skills: 20 };
const GRADE_CUTOFFS = [['A', 80], ['B', 65], ['C', 50]];
const ACCEPT = { A: ['A'], AB: ['A', 'B'], ABC: ['A', 'B', 'C'] };
const ACCEPT_LABEL = { A: 'A only', AB: 'A and B', ABC: 'A to C' };
const PAY_DERIVED_PCT = { top: 30, good: 15 };
const DEFAULT_RADIUS_MI = 35;
const DEFAULT_STALE_DAYS = 21;

const PRIORITY_RANK = { ideal: 3, good: 2, acceptable: 1 };
const STRENGTH_RANK = { strong: 2, some: 1 };

const norm = s => String(s == null ? '' : s).trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isSet = v => v != null && v !== '' && Number.isFinite(Number(v));

// Whole-word, case-insensitive. Lookarounds rather than \b so terms that end
// in punctuation ("C++", "Sr.") still match.
function wordRe(term) {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(norm(term))}(?![A-Za-z0-9])`, 'i');
}

// ── Moving an older config to this layout ───────────────────────────────────

function keepBest(map, key, entry, rankOf) {
  const k = key.toLowerCase();
  const cur = map.get(k);
  if (!cur || rankOf(entry) > rankOf(cur)) map.set(k, entry);
}

function fromEarlierLayout(cfg) {
  // Title score lists (5 / 4 / 3) become role priorities. Required title
  // terms that were not in any score list become Acceptable roles.
  const roles = new Map();
  for (const tier of cfg.scoring?.title_tiers || []) {
    if (!('score' in tier)) continue;
    const priority = tier.score >= 5 ? 'ideal' : tier.score === 4 ? 'good' : 'acceptable';
    for (const kw of tier.keywords || []) {
      if (norm(kw)) keepBest(roles, norm(kw), { title: norm(kw), priority }, e => PRIORITY_RANK[e.priority]);
    }
  }
  for (const t of cfg.title_filters?.title_require || []) {
    if (norm(t)) keepBest(roles, norm(t), { title: norm(t), priority: 'acceptable' }, e => PRIORITY_RANK[e.priority]);
  }

  // Domain tiers 5 and 4 were the strongest industry signals; 3 and 2 weaker.
  const industries = new Map();
  const ds = cfg.domain_scoring || {};
  for (const [tierKey, strength] of [['tier5', 'strong'], ['tier4', 'strong'], ['tier3', 'some'], ['tier2', 'some']]) {
    for (const name of ds[tierKey] || []) {
      if (norm(name)) keepBest(industries, norm(name), { name: norm(name), strength }, e => STRENGTH_RANK[e.strength]);
    }
  }

  // Qualification words that scored 3 or more become skills. Lower tiers
  // marked weaker postings, so they are not carried over. Scope words are
  // not carried over either: they described how big a role is ("delivery",
  // "cross-functional") and turn up in most postings, so as skills they
  // would raise nearly every score without telling jobs apart.
  const skills = new Map();
  for (const tier of cfg.scoring?.requirement_tiers || []) {
    if (!('score' in tier) || tier.score < 3) continue;
    for (const kw of tier.keywords || []) if (norm(kw)) skills.set(norm(kw).toLowerCase(), norm(kw));
  }
  const scopeWords = (cfg.scoring?.scope_tiers || []).flatMap(t => t.keywords || []).filter(norm);

  return { roles: [...roles.values()], industries: [...industries.values()], skills: [...skills.values()], scopeWords };
}

// Earlier layout: every grade but D was accepted, and a stricter bar was
// expressed as a higher grade C cutoff on a total of 5 x the weights. That
// cutoff is mapped onto the new grade cutoffs by percentage.
function acceptFromEarlier(track) {
  const w = track.score_weights || {};
  const total = 5 * ['d1', 'd2', 'd3', 'd4', 'd5'].reduce((s, k) => s + (Number(w[k]) || 1), 0);
  const cPct = track.grade_c != null ? (Number(track.grade_c) / total) * 100 : 0;
  return cPct >= 80 ? 'A' : cPct >= 65 ? 'AB' : 'ABC';
}

const preview = (list, n = 5) => list.slice(0, n).join(', ') + (list.length > n ? `, and ${list.length - n} more` : '');

/**
 * Brings a config of any earlier layout up to CONFIG_VERSION. Idempotent: a
 * current config comes back unchanged. Returns { config, changed, notes },
 * where notes say in plain words what was converted or could not be.
 * The input is never modified.
 */
function migrateConfig(input) {
  const from = input?.config_version || 0;
  if (from >= CONFIG_VERSION) return { config: input, changed: false, notes: [] };
  const cfg = JSON.parse(JSON.stringify(input || {}));
  const notes = [];
  if (from < 2) toVersion2(cfg, notes);
  if (from < 3) toVersion3(cfg, notes);
  cfg.config_version = CONFIG_VERSION;
  if (notes.length) cfg.migration_notes = [...(cfg.migration_notes || []), ...notes];
  return { config: cfg, changed: true, notes };
}

// Version 2: roles, industries and skills replace the score lists; tracks get
// a grade bar instead of cutoffs and weights.
function toVersion2(cfg, notes) {
  if (!Array.isArray(cfg.roles)) {
    const c = fromEarlierLayout(cfg);
    cfg.roles = c.roles;
    cfg.industries = c.industries;
    cfg.skills = c.skills;
    if (c.roles.length || c.industries.length || c.skills.length) {
      notes.push(`Your title score lists and required title terms became ${c.roles.length} roles, ` +
        `your domain lists became ${c.industries.length} industries, and your qualification words became ${c.skills.length} skills.`);
    }
    if (c.scopeWords.length) {
      notes.push(`Scope words were not carried over, because they appear in most postings and raised nearly every score: ${preview(c.scopeWords)}. ` +
        'Add any that matter to Skills.');
    }
  }
  if (!Array.isArray(cfg.industries)) cfg.industries = [];
  if (!Array.isArray(cfg.skills)) cfg.skills = [];

  for (const t of cfg.tracks || []) {
    const name = t.label || t.key;
    if (!ACCEPT[t.accept_grades]) t.accept_grades = acceptFromEarlier(t);
    if (typeof t.industry_required !== 'boolean') {
      t.industry_required = t.min_domain_score != null && Number(t.min_domain_score) >= 2;
    }
    if (isSet(t.salary_score_3) && Number(t.salary_score_3) !== (Number(t.salary_floor) || 0)) {
      notes.push(`Track "${name}": the third pay band ($${Math.round(Number(t.salary_score_3) / 1000)}K) was removed. ` +
        'Pay at or above the floor now earns the floor-level points.');
    }
    if (!('pay_top' in t)) {
      t.pay_top  = isSet(t.salary_score_5) ? Number(t.salary_score_5) : null;
      t.pay_good = isSet(t.salary_score_5) && isSet(t.salary_score_4) ? Number(t.salary_score_4) : null;
    }
    if ((t.level_cap_b || []).length) {
      const example = cfg.roles[0] ? ` For example "${t.level_cap_b[0]} ${cfg.roles[cfg.roles.length - 1].title}".` : '';
      notes.push(`Track "${name}": the level cap (${preview(t.level_cap_b)}) has no equivalent. ` +
        `To rank those titles lower, add them as Acceptable roles.${example}`);
    }
    if (t.domain_cap_at != null) {
      notes.push(`Track "${name}": the domain cap was removed. Use "Require an industry match" to keep out jobs with no listed industry.`);
    }
    t.clearance_behavior = t.clearance_behavior === 'reject' ? 'reject' : 'flag';
    for (const k of ['grade_a', 'grade_b', 'grade_c', 'score_weights', 'min_domain_score', 'domain_cap_at',
                     'level_cap_b', 'salary_score_5', 'salary_score_4', 'salary_score_3']) delete t[k];
  }

  const premium = cfg.company_lists?.premium_agencies || [];
  if (premium.length) notes.push(`"Allowed Agencies" was never used by the app and was removed: ${preview(premium)}.`);
  const routing = (cfg.pipeline?.track_routing || []).length;
  const copies = Object.keys(cfg.pipeline?.generate_copies || {}).length;
  if (routing || copies) notes.push('Track routing and copy rules were removed: every job is already checked against every track, in track order.');

  delete cfg.scoring;
  delete cfg.domain_scoring;
  if (cfg.title_filters) delete cfg.title_filters.title_require;
  if (cfg.company_lists) delete cfg.company_lists.premium_agencies;
  cfg.settings = cfg.settings || {};
  delete cfg.settings.slow_mo;
  delete cfg.settings.dashboard_browser;
  if (!('stale_after_days' in cfg.settings)) cfg.settings.stale_after_days = DEFAULT_STALE_DAYS;
  cfg.pipeline = { search_term: cfg.pipeline?.search_term || '' };
}

// Version 3: staffing firms are tagged, not suspected; reposting sites and
// duplicate postings are handled separately; tracks choose employment types.
function toVersion3(cfg, notes) {
  const cl = cfg.company_lists = cfg.company_lists || {};
  if (!Array.isArray(cl.staffing_firms)) cl.staffing_firms = Array.isArray(cl.blocked_agencies) ? cl.blocked_agencies : [];
  delete cl.blocked_agencies;
  cfg.sources = { ...JSON.parse(JSON.stringify(DEFAULT_SOURCES)), ...(cfg.sources || {}) };
  // Names on the old agency list that are reposting sites belong on that list.
  const sites = new Set(cfg.sources.reposting_sites.map(x => norm(x).toLowerCase()));
  const moved = cl.staffing_firms.filter(x => sites.has(norm(x).toLowerCase()));
  if (moved.length) {
    cl.staffing_firms = cl.staffing_firms.filter(x => !sites.has(norm(x).toLowerCase()));
    notes.push(`${moved.length === 2 ? moved.join(' and ') : preview(moved)} ${moved.length === 1 ? 'is a reposting site' : 'are reposting sites'}, ` +
      'so they were moved from your agency list to Job boards and reposting sites.');
  }
  for (const t of cfg.tracks || []) {
    if (!Array.isArray(t.employment_types)) t.employment_types = [];
    // Pay levels at or below the floor gave every role that cleared the floor
    // full pay points, so pay never told those roles apart.
    const floor = Number(t.salary_floor) || 0;
    if (floor > 0 && isSet(t.pay_top) && Number(t.pay_top) <= floor) {
      notes.push(`Track "${t.label || t.key}": ideal pay ($${Math.round(t.pay_top / 1000)}K) was at or below its floor ` +
        `($${Math.round(floor / 1000)}K), so every role above the floor got full pay points. Good and ideal pay are now automatic ` +
        `(floor +${PAY_DERIVED_PCT.good}% and +${PAY_DERIVED_PCT.top}%).`);
      t.pay_top = null; t.pay_good = null;
    }
  }
  if (cfg.setup_complete === true) {
    notes.push('Staffing firms are no longer treated as suspect: their roles stay in your results, tagged "Staffing firm". ' +
      'Your agency list is now your staffing firms list.');
    notes.push(`Postings made by job boards and reposting sites (${preview(DEFAULT_SOURCES.reposting_sites, 4)}) are now rejected, ` +
      'and the same job posted by several companies is shown once. Both are on the Avoid tab.');
  }
}

// ── Reading the config ──────────────────────────────────────────────────────

/**
 * The user's criteria, compiled for matching.
 * Roles are ordered most specific first (longest title), so "senior data
 * analyst" is tried before "data analyst".
 */
function criteriaFromConfig(input) {
  const cfg = migrateConfig(input).config;
  const roles = (cfg.roles || []).filter(r => norm(r.title))
    .map(r => ({ title: norm(r.title), priority: PRIORITY_POINTS[r.priority] ? r.priority : 'acceptable' }));
  const industries = (cfg.industries || []).filter(i => norm(i.name))
    .map(i => ({ name: norm(i.name), strength: STRENGTH_POINTS[i.strength] ? i.strength : 'some' }));
  const skills = [...new Set((cfg.skills || []).map(norm).filter(Boolean))];
  return {
    roles: roles
      .map(r => ({ ...r, re: wordRe(r.title) }))
      .sort((a, b) => b.title.length - a.title.length || PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]),
    industries: industries
      .map(i => ({ ...i, re: wordRe(i.name) }))
      .sort((a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength]),
    skills: skills.map(s => ({ word: s, re: wordRe(s) })),
  };
}

/** Which grades a track accepts: 'A', 'AB' or 'ABC' (the default). */
function acceptFor(track) {
  return ACCEPT[track.accept_grades] ? track.accept_grades : 'ABC';
}

/** Whether a track rejects jobs that match none of the listed industries. */
function industryRequired(track) {
  return track.industry_required === true;
}

/** Commute radius for a track, in miles. */
function radiusFor(track) {
  return isSet(track.target_radius_mi) ? Number(track.target_radius_mi) : DEFAULT_RADIUS_MI;
}

/** Pay levels for a track, or null when the track sets no floor and no ideal pay (pay_top). */
function payBands(track) {
  const floor = Number(track.salary_floor) || 0;
  if (!isSet(track.pay_top) && floor <= 0) return null;
  const toK = v => Math.round(v / 1000) * 1000;
  const derived = !isSet(track.pay_top);
  return {
    derived,
    top:  derived ? toK(floor * (100 + PAY_DERIVED_PCT.top) / 100) : Number(track.pay_top),
    good: isSet(track.pay_good) ? Number(track.pay_good)
        : derived ? toK(floor * (100 + PAY_DERIVED_PCT.good) / 100) : null,
    floor,
  };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const K = v => `$${Math.round(v / 1000)}K`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function matchRole(title, crit) {
  return crit.roles.find(r => r.re.test(title || '')) || null;
}

/**
 * Score one job for one track.
 *   job: { title, text, mid, noSalary }   text = everything in the posting
 * Returns { score, grade, parts }, grade null when below 50.
 */
function scoreJob(job, crit, track) {
  const parts = [];

  if (crit.roles.length) {
    const hit = matchRole(job.title, crit);
    parts.push(hit
      ? { signal: 'Title', points: PRIORITY_POINTS[hit.priority], max: MAX.Title, detail: `${cap(hit.priority)}: "${hit.title}"` }
      : { signal: 'Title', points: 0, max: MAX.Title, detail: 'No listed role in the title' });
  }

  const bands = payBands(track);
  if (bands) {
    const lbl = bands.derived
      ? { top: `${PAY_DERIVED_PCT.top}%+ over your floor`, good: `${PAY_DERIVED_PCT.good}%+ over your floor` }
      : { top: `ideal pay (${K(bands.top)}+)`, good: bands.good != null ? `good pay (${K(bands.good)}+)` : '' };
    let points, detail;
    if (job.noSalary || job.mid == null)                  { points = PAY_POINTS.below; detail = 'Not listed'; }
    else if (job.mid >= bands.top)                         { points = PAY_POINTS.top;   detail = `${K(job.mid)}, ${lbl.top}`; }
    else if (bands.good != null && job.mid >= bands.good) { points = PAY_POINTS.good;  detail = `${K(job.mid)}, ${lbl.good}`; }
    else if (job.mid >= bands.floor)                       { points = PAY_POINTS.floor; detail = `${K(job.mid)}, at or above your floor`; }
    else                                                   { points = PAY_POINTS.below; detail = `${K(job.mid)}, below your floor`; }
    parts.push({ signal: 'Pay', points, max: MAX.Pay, detail });
  }

  if (crit.industries.length) {
    const hit = crit.industries.find(i => i.re.test(job.text || ''));
    parts.push(hit
      ? { signal: 'Industry', points: STRENGTH_POINTS[hit.strength], max: MAX.Industry, detail: `${cap(hit.strength)}: "${hit.name}"` }
      : { signal: 'Industry', points: 0, max: MAX.Industry, detail: 'No listed industry found' });
  }

  if (crit.skills.length) {
    // A short list can still earn the full signal: 5 per listed word, up to 20.
    const max = Math.min(MAX.Skills, SKILL_POINTS * crit.skills.length);
    const found = crit.skills.filter(s => s.re.test(job.text || '')).map(s => s.word);
    const shown = found.slice(0, 4).map(w => `"${w}"`).join(', ') + (found.length > 4 ? ', ...' : '');
    parts.push({
      signal: 'Skills', points: Math.min(max, SKILL_POINTS * found.length), max,
      detail: found.length ? `${found.length} of ${crit.skills.length}: ${shown}` : `None of ${crit.skills.length} listed`,
    });
  }

  const max = parts.reduce((s, p) => s + p.max, 0);
  const score = max ? Math.round(parts.reduce((s, p) => s + p.points, 0) / max * 100) : 100;
  const grade = (GRADE_CUTOFFS.find(([, min]) => score >= min) || [null])[0];
  return { score, grade, parts };
}

/**
 * A posting older than staleDays is shown one grade lower, never below C.
 * staleDays blank or 0 turns this off.
 */
function ageAdjust(grade, days, staleDays) {
  if (!grade || days == null || !isSet(staleDays) || Number(staleDays) <= 0 || days <= Number(staleDays)) {
    return { grade, note: null };
  }
  const lower = { A: 'B', B: 'C', C: 'C' }[grade];
  return lower === grade
    ? { grade, note: null }
    : { grade: lower, note: `Posted ${Math.floor(days)} days ago: lowered one grade` };
}

/** The scoring rules, for the config page to show exactly what the engine does. */
const RULES = {
  rolePoints: PRIORITY_POINTS, industryPoints: STRENGTH_POINTS, payPoints: PAY_POINTS,
  skillPoints: SKILL_POINTS, max: MAX, gradeCutoffs: GRADE_CUTOFFS, acceptLabels: ACCEPT_LABEL,
  payDerivedPct: PAY_DERIVED_PCT, defaultRadiusMi: DEFAULT_RADIUS_MI, defaultStaleDays: DEFAULT_STALE_DAYS,
  employmentTypes: EMPLOYMENT_TYPES, notStated: NOT_STATED, postedBy: POSTED_BY, defaultSources: DEFAULT_SOURCES,
  configVersion: CONFIG_VERSION,
};

module.exports = {
  migrateConfig, criteriaFromConfig, scoreJob, matchRole, ageAdjust, acceptFor, payBands, industryRequired, radiusFor,
  ACCEPT, ACCEPT_LABEL, GRADE_CUTOFFS, RULES, CONFIG_VERSION, DEFAULT_RADIUS_MI, DEFAULT_STALE_DAYS,
};
