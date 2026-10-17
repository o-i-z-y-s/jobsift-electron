'use strict';

/**
 * src/sources.js
 * Who posted a job and on what terms, and which postings are the same job.
 *
 *   Employment type  Full-time, Contract, Part-time and so on, as the posting
 *                    states it. A posting that does not say is "Not stated".
 *   Posted by        Employer       the hiring company itself
 *                    Staffing firm  an agency filling the role for a client;
 *                                   a real job, often the only way in
 *                    Job board      a job board or reposting site that copied
 *                                   someone else's posting
 *   Duplicates       the same title with mostly the same description, posted
 *                    by different companies in one run: one job, kept once.
 *
 * Every list used to recognize these is in the config (cfg.sources and
 * cfg.company_lists.staffing_firms), so it can be read and edited on the
 * config page. DEFAULT_SOURCES is only what a new or migrated config starts with.
 *
 * No Electron dependency, so this module can be tested directly with node.
 */

const EMPLOYMENT_TYPES = ['Full-time', 'Contract', 'Contract to hire', 'Part-time', 'Temporary', 'Internship'];
const NOT_STATED = 'Not stated';

const POSTED_BY = { employer: 'Employer', staffing: 'Staffing firm', job_board: 'Job board' };

const DEFAULT_SOURCES = {
  // What to do with postings made by a job board or reposting site itself.
  reposts: 'reject',                      // 'reject' | 'flag' | 'off'
  // Company names that are job boards or reposting sites, not employers.
  reposting_sites: ['Dice', 'Jobgether', 'Lensa', 'Jooble', 'Talent.com', 'ZipRecruiter', 'RemoteHunter'],
  // Apply-link sites that are job boards. Employers post there too, so a link
  // here is flagged, never rejected.
  job_board_links: ['linkedin.com', 'dice.com', 'ziprecruiter.com', 'indeed.com', 'glassdoor.com', 'monster.com',
                    'careerbuilder.com', 'simplyhired.com', 'talent.com', 'jooble.org', 'lensa.com', 'jobgether.com'],
  // Apply-link sites that are recruiting software used by staffing firms.
  staffing_links: ['jobdiva.com', 'bullhorn', 'ceipal.com', 'zohorecruit', 'jobadder.com', 'avionte.com',
                   'tempworks', 'crelate.com', 'loxo.co', 'recruitcrm.io', 'manatal.com'],
};

const norm = s => String(s == null ? '' : s).trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = t => new RegExp(`(?<![A-Za-z0-9])${escapeRe(norm(t))}(?![A-Za-z0-9])`, 'i');

function hostOf(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(norm(url));
  return m ? m[1].toLowerCase().replace(/^www\d*\./, '') : '';
}

// ── Employment type ─────────────────────────────────────────────────────────

/** Map a stated employment type onto EMPLOYMENT_TYPES, or null if unknown. */
function normalizeEmploymentType(raw) {
  const s = norm(raw).toLowerCase().replace(/[_\s-]+/g, ' ');
  if (!s) return null;
  if (/contract (to|2) hire|\bc2h\b|temp(orary)? to (hire|perm)/.test(s)) return 'Contract to hire';
  if (/\bintern(ship)?\b/.test(s)) return 'Internship';
  if (/\bpart ?-?time\b|\bparttime\b/.test(s)) return 'Part-time';
  if (/\btemp(orary)?\b|\bseasonal\b/.test(s)) return 'Temporary';
  if (/\bcontract(or)?\b|\bfreelance\b/.test(s)) return 'Contract';
  if (/\bfull ?-?time\b|\bfulltime\b|\bpermanent\b|\bregular\b/.test(s)) return 'Full-time';
  return null;
}

// Jobright prints the type on a line of its own on the job card.
const CARD_TYPE_LINE = /^(full-time|part-time|contract|contract to hire|internship|temporary|freelance)$/i;
// Titles that state it, set apart from the job name: "Analyst (Contract)",
// "Contractor - Analyst", "Analyst, Part-time". A word that is part of the job
// name itself ("Contract Manager", "Internal Tools") does not count.
const SEP = '[(\\[|,:\\-\u2013]';
const TITLE_TYPE = new RegExp(
  `\\b(contract[- ]to[- ]hire|part[- ]time|temporary|internship)\\b` +
  `|(?:^|${SEP})\\s*(contract(?:or)?|temp|intern)\\s*(?=$|${SEP.replace('[', '[)\\]')})`, 'i');

/** The posting's employment type, or NOT_STATED. */
function employmentTypeOf(rec) {
  const stated = normalizeEmploymentType(rec.employment_type);
  if (stated) return stated;
  for (const line of String(rec.card_text || '').split('\n')) {
    if (CARD_TYPE_LINE.test(line.trim())) return normalizeEmploymentType(line);
  }
  const m = TITLE_TYPE.exec(rec.title || '');
  return (m && normalizeEmploymentType(m[1] || m[2])) || NOT_STATED;
}

// ── Posted by ───────────────────────────────────────────────────────────────

/** The source lists from the config, compiled once per run. */
function sourcesFromConfig(cfg) {
  const s = { ...DEFAULT_SOURCES, ...(cfg.sources || {}) };
  const list = v => (Array.isArray(v) ? v : []).map(norm).filter(Boolean);
  const mode = ['reject', 'flag', 'off'].includes(s.reposts) ? s.reposts : DEFAULT_SOURCES.reposts;
  return {
    reposts: mode,
    repostingSites: list(s.reposting_sites).map(n => ({ name: n, re: wordRe(n) })),
    jobBoardLinks:  list(s.job_board_links).map(h => h.toLowerCase()),
    staffingLinks:  list(s.staffing_links).map(h => h.toLowerCase()),
    staffingFirms:  list(cfg.company_lists?.staffing_firms).map(n => ({ name: n, re: wordRe(n) })),
  };
}

// A Jobright card reads, one item per line: posted date and badges, the job
// title, the company, "/", the company's industry tags ("Staffing & Recruiting
// · Early Stage"), then location, employment type, pay, and work arrangement.
function cardFields(cardText) {
  const lines = String(cardText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const i = lines.indexOf('/');
  if (i < 2) return null;
  const rest = lines.slice(i + 2);
  return {
    title:     lines[i - 2],
    company:   lines[i - 1],
    tags:      lines[i + 1] || '',
    location:  rest[0] || '',
    salary:    rest.find(l => /\$/.test(l)) || '',
    work_type: rest.find(l => /^(remote|hybrid|on.?site|in.person)$/i.test(l)) || '',
  };
}

// The company line on a Jobright card is followed by "/" and its industry
// tags, e.g. "Staffing & Recruiting · Early Stage".
function cardTags(cardText) {
  const lines = String(cardText || '').split('\n');
  const i = lines.findIndex(l => l.trim() === '/');
  return i >= 0 ? (lines[i + 1] || '') : '';
}

/**
 * Who posted the job.
 * Returns { kind: 'employer' | 'staffing' | 'job_board', label, reasons: [], boardLink }
 * boardLink is the job-board site the Apply link goes to, if any.
 */
function postedBy(rec, src) {
  const company = norm(rec.company);
  const host = hostOf(rec.ats_url || rec.url);
  // "dice.com" matches that site and its subdomains; a bare word ("bullhorn")
  // matches any host containing it, for software hosted on many domains.
  const linkMatches = list => list.find(h => (h.includes('.') ? host === h || host.endsWith('.' + h) : host.includes(h))) || null;
  const boardLink = linkMatches(src.jobBoardLinks);

  const site = src.repostingSites.find(s => s.re.test(company));
  if (site) {
    return { kind: 'job_board', label: POSTED_BY.job_board, boardLink,
             reasons: [`${company} is a job board or reposting site (your reposting sites list), not the employer`] };
  }

  const reasons = [];
  const system = linkMatches(src.staffingLinks);
  if (system) reasons.push(`Apply link goes to ${system}, recruiting software used by staffing firms`);
  const firm = src.staffingFirms.find(f => f.re.test(company));
  if (firm) reasons.push(`${firm.name} is on your staffing firms list`);
  if (/staffing/i.test(cardTags(rec.card_text))) reasons.push('Jobright lists the company as a staffing firm');
  if (reasons.length) return { kind: 'staffing', label: POSTED_BY.staffing, reasons, boardLink };

  return { kind: 'employer', label: POSTED_BY.employer, reasons: [], boardLink };
}

/**
 * postedBy() for every listing in a run. A company with clear staffing-firm
 * evidence on any of its postings (agency software, your list, Jobright's
 * label) is treated as a staffing firm on all of them, since the same firm
 * often posts some roles through LinkedIn instead.
 */
function postedByAll(records, src) {
  const out = records.map(r => postedBy(r, src));
  const key = r => norm(r.company).toLowerCase();
  const firms = new Set(records.filter((r, i) => out[i].kind === 'staffing').map(key));
  return out.map((by, i) => (by.kind === 'employer' && firms.has(key(records[i]))
    ? { ...by, kind: 'staffing', label: POSTED_BY.staffing,
        reasons: [`Other postings by ${norm(records[i].company)} in this scrape show it is a staffing firm`] }
    : by));
}

// ── Duplicates ──────────────────────────────────────────────────────────────

const SAME_JOB_SHARE = 0.5;   // share of description words two copies have in common
const words = s => new Set((String(s || '').toLowerCase().match(/[a-z]{4,}/g)) || []);
const titleKey = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function shared(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

/**
 * Groups postings that are the same job: same title, mostly the same
 * description, different companies. items: [{ title, company, text, ... }].
 * Returns arrays of items; a job posted once is a group of one.
 */
function groupSameJob(items) {
  const parent = items.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byTitle = new Map();
  items.forEach((it, i) => {
    it._words = it._words || words(it.text);
    const k = titleKey(it.title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(i);
  });
  for (const idx of byTitle.values()) {
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        const a = items[idx[x]], b = items[idx[y]];
        if (norm(a.company).toLowerCase() === norm(b.company).toLowerCase()) continue;
        if (shared(a._words, b._words) >= SAME_JOB_SHARE) parent[find(idx[y])] = find(idx[x]);
      }
    }
  }
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  for (const it of items) delete it._words;
  return [...groups.values()];
}

/** Which copy of a job to keep: the employer's own, then a staffing firm, then a job board. */
const SOURCE_RANK = { employer: 0, staffing: 1, job_board: 2 };

module.exports = {
  EMPLOYMENT_TYPES, NOT_STATED, POSTED_BY, DEFAULT_SOURCES, SOURCE_RANK, SAME_JOB_SHARE,
  normalizeEmploymentType, employmentTypeOf, sourcesFromConfig, postedBy, postedByAll, groupSameJob, hostOf, cardFields,
};
