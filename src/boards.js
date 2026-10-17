'use strict';

/**
 * src/boards.js
 * Which public job board each company uses, how to find it from a company
 * name, and the record of every board found so far.
 *
 *   Known boards  known_boards.json in the app data folder: one entry per
 *                 company (by companyKey), holding the hiring system, the board
 *                 identifier (see BOARD_FIELDS), where the entry came from,
 *                 when it last answered, and its status:
 *                   ok     the board answered, or is believed to
 *                   stale  the board stopped answering (404 or similar); kept,
 *                          never silently dropped, and looked up again
 *                   none   no public board was found ("own hiring site");
 *                          looked up again after recheck_after
 *                 Entries the user made by hand (source "manual") always win
 *                 over learned ones. Beside the boards, the file keeps other
 *                 facts per company: the careers site its apply links lead to
 *                 when JobSift cannot read it, the last failed lookup, and
 *                 whether its roles were found on a board shared with another
 *                 company. coverage() turns all of it into one status.
 *   Lookup        lookup() finds a company's board from its name:
 *                   1. an existing known-boards entry
 *                   2. likely boards on every system in GUESSES, kept only
 *                      when the board reports the same company name and
 *                      lists a posting
 *                   3. a careers page scan, when the user gave a careers page
 *                      link: the page is searched for a board on any system
 *                      in SYSTEMS, and its address is asked whether it is an
 *                      iCIMS or Eightfold career site (see probeCareersSite)
 *                   4. the careers site the company's apply links lead to,
 *                      when it is the company's own (see askableSite): its
 *                      main page scanned the same way, and asked the same
 *                      question
 *                 Workday and Oracle boards, and iCIMS career sites, cannot
 *                 be guessed from a name; they are found by steps 3 and 4, or
 *                 from apply links. Name guesses only ever go to the hiring
 *                 systems' own sites.
 *   Apply links   boardFromUrl() reads the board out of an apply link, so every
 *                 Jobright run teaches JobSift the boards of the employers it saw.
 *
 * Only company names and board names are ever sent to the hiring sites, and
 * only to ask for their public listings. Requests are at least 500 ms apart.
 *
 * No Electron dependency, so this module can be tested directly with node.
 */

const fs   = require('fs');
const path = require('path');
const { companyWords, companyKey, notACompany } = require('./connections');

const FILE = 'known_boards.json';
const OLD_WORKDAY_CACHE = 'workday_urls_cache.json';
const SYSTEMS = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday', eightfold: 'Eightfold',
  oracle: 'Oracle', gem: 'Gem', icims: 'iCIMS', rippling: 'Rippling', workable: 'Workable',
};
// How each system's boards are identified. A board name ({ slug }) for these:
const SLUG_SYSTEMS = ['greenhouse', 'lever', 'ashby', 'gem', 'rippling', 'workable'];
// and an object of these fields for the rest, kept in the config's ats_boards
// under key (Workday's under workday_direct).
const BOARD_FIELDS = {
  workday:   { key: 'workday_direct', fields: ['base_url', 'tenant', 'site'] },
  oracle:    { key: 'oracle',         fields: ['base_url', 'site'] },
  eightfold: { key: 'eightfold',      fields: ['base_url', 'domain'] },
  icims:     { key: 'icims',          fields: ['base_url'] },
};
const SOURCES = ['manual', 'lookup', 'apply_link', 'careers_page'];
const DEFAULT_RECHECK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const GH_API = 'https://boards-api.greenhouse.io/v1/boards';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Board identifiers ───────────────────────────────────────────────────────

const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

/** The part of a board that identifies it, for display: "acme", "acme/AcmeCareers", "careers.acme.com". */
function boardId(ats, board) {
  if (!board) return '';
  if (ats === 'workday') return `${board.tenant}/${board.site}`;
  if (ats === 'oracle') return `${hostOf(board.base_url)}/${board.site}`;
  if (ats === 'eightfold' || ats === 'icims') return hostOf(board.base_url);
  return board.slug;
}

/**
 * The boards in a config's ats_boards, as [{ company, ats, board }], in the
 * order of SLUG_SYSTEMS then BOARD_FIELDS. Entries missing a value are left out.
 */
function boardsFromConfig(ab = {}) {
  const rows = [];
  for (const ats of SLUG_SYSTEMS) {
    for (const [company, slug] of Object.entries(ab[ats] || {})) {
      const s = String(slug || '').trim();
      if (s) rows.push({ company, ats, board: { slug: s } });
    }
  }
  for (const [ats, { key, fields }] of Object.entries(BOARD_FIELDS)) {
    for (const [company, info] of Object.entries(ab[key] || {})) {
      if (info && fields.every(f => String(info[f] || '').trim())) {
        rows.push({ company, ats, board: Object.fromEntries(fields.map(f => [f, String(info[f]).trim()])) });
      }
    }
  }
  return rows;
}

// The domain an Eightfold site serves its jobs under: "acme.com" for
// careers.acme.com. Eightfold's own hosts (acme.eightfold.ai) use the
// company's name with .com.
function siteDomain(host) {
  const parts = host.toLowerCase().split('.');
  if (host.endsWith('.eightfold.ai')) return `${parts[0]}.com`;
  return parts.slice(-2).join('.');
}

function sameBoard(a, b) {
  if (!a || !b || a.ats !== b.ats || !a.board || !b.board) return false;
  return boardId(a.ats, a.board).toLowerCase() === boardId(b.ats, b.board).toLowerCase();
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LOCALE_RE = /^[a-z]{2}(?:[-_][A-Za-z]{2})?$/;

/**
 * The board an apply link or board link points to: { ats, board } or null.
 *   Greenhouse  boards.greenhouse.io/{slug}/..., job-boards.greenhouse.io/{slug}/...,
 *               .../embed/job_app?for={slug}, boards-api.greenhouse.io/v1/boards/{slug}
 *   Lever       jobs.lever.co/{slug}/..., api.lever.co/v0/postings/{slug}
 *   Ashby       jobs.ashbyhq.com/{slug}/..., api.ashbyhq.com/posting-api/job-board/{slug}
 *   Workday     {tenant}.wd{N}.myworkdayjobs.com/[locale/]{site}/...,
 *               wd{N}.myworkdaysite.com/[locale/]recruiting/{tenant}/{site}/...
 *   Gem         jobs.gem.com/{slug}/..., api.gem.com/job_board/v0/{slug}
 *   Rippling    ats.rippling.com/{slug}/..., api.rippling.com/platform/api/ats/v1/board/{slug}
 *   Workable    apply.workable.com/{slug}/..., {slug}.workable.com/...
 *   Eightfold   {name}.eightfold.ai/..., or any site's /careers/job/{id}?domain={domain}
 *   Oracle      {pod}.oraclecloud.com/hcmUI/CandidateExperience/[locale/]sites/{site}/...,
 *               or the same path on a company's own domain; with no site in
 *               the link, the usual first site, CX_1
 * iCIMS career sites on a company's own domain cannot be told apart from
 * other sites by their links; see probeCareersSite.
 */
function boardFromUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  const slug = s => (s && SLUG_RE.test(s.trim()) ? s.trim().toLowerCase() : null);
  const make = (ats, s) => (s ? { ats, board: { slug: s } } : null);

  if (host === 'boards-api.greenhouse.io') {
    return parts[0] === 'v1' && parts[1] === 'boards' ? make('greenhouse', slug(parts[2])) : null;
  }
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    if (parts[0] === 'embed') return make('greenhouse', slug(u.searchParams.get('for')));
    return make('greenhouse', slug(parts[0]));
  }
  if (host === 'api.lever.co') {
    return parts[0] === 'v0' && parts[1] === 'postings' ? make('lever', slug(parts[2])) : null;
  }
  if (host === 'jobs.lever.co') return make('lever', slug(parts[0]));
  if (host === 'api.ashbyhq.com') {
    return parts[0] === 'posting-api' && parts[1] === 'job-board' ? make('ashby', slug(parts[2])) : null;
  }
  if (host === 'jobs.ashbyhq.com') return parts[0] === 'api' ? null : make('ashby', slug(parts[0]));

  const wd = /^([a-z0-9][a-z0-9_-]*)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const tenant = wd[1];
    let site = null;
    if (parts[0] === 'wday' && parts[1] === 'cxs') site = parts[3];
    else site = parts.find(p => !LOCALE_RE.test(p)) || null;
    if (!site || !SLUG_RE.test(site)) return null;
    return { ats: 'workday', board: { base_url: `https://${host}`, tenant, site } };
  }
  // The second Workday address: one host for many companies, the company in the path.
  if (/^wd\d+\.myworkdaysite\.com$/.test(host)) {
    const i = parts[0] === 'wday' && parts[1] === 'cxs' ? 1 : parts.indexOf('recruiting');
    const tenant = i >= 0 ? parts[i + 1] : null;
    const site = i >= 0 ? parts[i + 2] : null;
    if (!tenant || !site || !SLUG_RE.test(tenant) || !SLUG_RE.test(site)) return null;
    return { ats: 'workday', board: { base_url: `https://${host}`, tenant: tenant.toLowerCase(), site } };
  }

  if (host === 'jobs.gem.com') return make('gem', slug(parts[0]));
  if (host === 'api.gem.com') return parts[0] === 'job_board' && parts[1] === 'v0' ? make('gem', slug(parts[2])) : null;
  if (host === 'ats.rippling.com') return make('rippling', slug(parts[0]));
  if (host === 'api.rippling.com') {
    const i = parts.indexOf('board');
    return parts[0] === 'platform' && i > 0 ? make('rippling', slug(parts[i + 1])) : null;
  }
  if (host === 'apply.workable.com') {
    if (parts[0] === 'api') {
      const i = parts.indexOf('accounts');
      return i > 0 ? make('workable', slug(parts[i + 1])) : null;
    }
    return parts[0] === 'j' ? null : make('workable', slug(parts[0]));
  }
  const wk = /^([a-z0-9][a-z0-9-]*)\.workable\.com$/.exec(host);
  if (wk && !['apply', 'www', 'jobs'].includes(wk[1])) return make('workable', wk[1]);

  const domainParam = (u.searchParams.get('domain') || '').toLowerCase();
  if (host.endsWith('.eightfold.ai') && host.split('.').length === 3 && host !== 'app.eightfold.ai') {
    return { ats: 'eightfold', board: { base_url: `https://${host}`, domain: domainParam.includes('.') ? domainParam : siteDomain(host) } };
  }
  if (/^\/careers\/job\/\d+/.test(u.pathname) && domainParam.includes('.')) {
    return { ats: 'eightfold', board: { base_url: u.origin.toLowerCase(), domain: domainParam } };
  }

  const ce = parts.indexOf('CandidateExperience');
  if (ce > 0 && parts[ce - 1] === 'hcmUI') {
    const s = parts.indexOf('sites');
    const site = s > ce && SLUG_RE.test(parts[s + 1] || '') ? parts[s + 1] : 'CX_1';
    return { ats: 'oracle', board: { base_url: u.origin.toLowerCase(), site } };
  }
  return null;
}

// ── Careers sites JobSift cannot read ───────────────────────────────────────

// Hiring systems by the domain their apply links use.
const OTHER_SYSTEMS = [
  ['icims.com', 'iCIMS hosted pages'], ['taleo.net', 'Taleo'], ['brassring.com', 'BrassRing'],
  ['successfactors.com', 'SuccessFactors'], ['successfactors.eu', 'SuccessFactors'], ['sapsf.com', 'SuccessFactors'],
  ['smartrecruiters.com', 'SmartRecruiters'], ['jobvite.com', 'Jobvite'], ['workable.com', 'Workable'],
  ['bamboohr.com', 'BambooHR'], ['ultipro.com', 'UKG'], ['ukg.com', 'UKG'], ['ukg.net', 'UKG'], ['adp.com', 'ADP'],
  ['dayforcehcm.com', 'Dayforce'], ['paylocity.com', 'Paylocity'],
  ['paycomonline.net', 'Paycom'], ['recruitingbypaycor.com', 'Paycor'], ['applytojob.com', 'JazzHR'],
  ['jazzhr.com', 'JazzHR'], ['recruitee.com', 'Recruitee'], ['teamtailor.com', 'Teamtailor'],
  ['ripplehire.com', 'RippleHire'],
  ['breezy.hr', 'Breezy'], ['avature.net', 'Avature'], ['personio.de', 'Personio'],
  ['personio.com', 'Personio'], ['pinpointhq.com', 'Pinpoint'], ['hibob.com', 'HiBob'],
  ['isolvedhire.com', 'isolved'], ['hrmdirect.com', 'HRM Direct'], ['comeet.com', 'Comeet'],
  ['hirebridge.com', 'Hirebridge'], ['applicantpro.com', 'ApplicantPro'], ['pageuppeople.com', 'PageUp'],
  ['careerpuck.com', 'CareerPuck'], ['gusto.com', 'Gusto'],
  ['saashr.com', 'UKG'], ['jobscore.com', 'JobScore'], ['jsco.re', 'JobScore'], ['darwinbox.in', 'Darwinbox'],
  ['darwinbox.com', 'Darwinbox'], ['cloud.sap', 'SuccessFactors'], ['paradox.ai', 'Paradox'],
  ['governmentjobs.com', 'NEOGOV'], ['trinethire.com', 'TriNet'], ['jobtarget.com', 'JobTarget'], ['kula.ai', 'Kula'],
  ['trakstar.com', 'Trakstar'], ['jibeapply.com', 'Jibe'], ['clearcompany.com', 'ClearCompany'], ['selectminds.com', 'SelectMinds'],
  ['paychex.com', 'Paychex'], ['mindscope.com', 'Mindscope'], ['catsone.com', 'CATS'], ['recruiterflow.com', 'Recruiterflow'],
  ['careers-page.com', 'Manatal'],
];
// Software companies use to hire contractors through staffing suppliers. A
// listing that leads to one is a contract role, not the company's own careers
// site, so it says nothing about where the company's other jobs are.
const CONTRACTOR_PLATFORMS = ['talentnet.community', 'fieldglass.net', 'beeline.com', 'vndly.com'];
// The systems JobSift does read. A link to one of them that boardFromUrl()
// cannot place (a Greenhouse application form with no board name in it) says
// nothing about the company's careers site, so it is ignored.
const READABLE_DOMAINS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com',
  'eightfold.ai', 'oraclecloud.com', 'oraclegovcloud.com', 'gem.com', 'rippling.com', 'rippling-ats.com', 'workable.com'];

const onDomain = (host, d) => host === d || host.endsWith('.' + d);

/**
 * Where an apply link leads when it is not a board JobSift can read:
 * { system, host } with system the hiring system's name, or null when the
 * link is to a careers site on no known system. Such a site's links can show
 * it may be an iCIMS or Eightfold career site, to be asked by
 * probeCareersSite(): then { probe: 'icims' | 'eightfold' } is added, with the
 * Eightfold domain when the link names one. Returns null for links to boards
 * JobSift reads, and to hosts in ignore (job boards and staffing software: a
 * bare word matches anywhere in the host name).
 */
function careersSiteFromUrl(url, ignore = []) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || boardFromUrl(u.href)) return null;
  // A company's own careers page in front of a Greenhouse board says so in its
  // link (gh_jid, gh_src); the board is found by looking the company up.
  if (u.searchParams.has('gh_jid') || u.searchParams.has('gh_src')) return null;
  const host = u.hostname.toLowerCase().replace(/^www\d*\./, '');
  if (!host.includes('.') || READABLE_DOMAINS.some(d => onDomain(host, d))) return null;
  if (['jobright.ai', ...ignore].some(h => (h.includes('.') ? onDomain(host, h) : host.includes(h)))) return null;
  if (CONTRACTOR_PLATFORMS.some(d => onDomain(host, d))) return null;
  const sys = OTHER_SYSTEMS.find(([d]) => onDomain(host, d));
  if (sys) return { system: sys[1], host };
  // iCIMS career sites list jobs at /jobs/{id}, Eightfold's at /careers/job/{id}.
  const site = { system: null, host };
  if (/^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/)?jobs\/\d+(?:[/-]|$)/i.test(u.pathname)) site.probe = 'icims';
  else if (/^\/careers\/job\/\d+/.test(u.pathname)) site.probe = 'eightfold';
  return site;
}

/**
 * Whether a careers site's address carries the company's name: one of its
 * words ("careers.acme.com"), its initials ("tcsapps.com" for Tata Consultancy
 * Services), or a short name as a whole part of the address ("careers.ey.com").
 * A name with umlauts or ß is also tried as addresses spell it ("Körber" as
 * "koerber").
 */
// Words too common in company names and addresses to show whose site it is.
const GENERIC_WORDS = new Set(['usa', 'america', 'american', 'north', 'national', 'global', 'international', 'group',
  'holdings', 'systems', 'solutions', 'services', 'technologies', 'technology', 'tech', 'partners', 'consulting',
  'digital', 'labs', 'enterprise', 'enterprises', 'careers', 'jobs']);
const SPELLED_OUT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
function ownSite(company, host) {
  const spelled = String(company || '').replace(/[äöüÄÖÜß]/g, c => SPELLED_OUT[c]);
  return [company, ...(spelled !== company ? [spelled] : [])].some(name => namedIn(name, host));
}
// The careers site from a company's apply links that JobSift asks for a board
// itself, or null: one on no hiring system it knows, whose address carries
// the company's name (ownSite) or whose links look like an iCIMS or Eightfold
// career site's. JobSift contacts no other address it has not been given.
function askableSite(company, site) {
  if (!site || !site.host || OTHER_SYSTEMS.some(([d]) => onDomain(site.host, d))) return null;
  return site.probe || ownSite(company, site.host) ? site : null;
}
function namedIn(company, host) {
  const flat = host.replace(/[^a-z0-9]/g, '');
  const parts = host.split(/[.-]/);
  const named = companyWords(company).filter(w => !MINOR_WORDS.has(w));
  const words = named.filter(w => !GENERIC_WORDS.has(w));
  const initials = named.map(w => w[0]).join('');
  return words.some(w => w.length >= 3 && flat.includes(w)) ||
         (initials.length >= 3 && flat.includes(initials)) ||
         parts.includes(words.join(''));
}

/**
 * Whether a board learned from an apply link plausibly belongs to that company
 * itself, judged from the board identifier alone: it contains the company's
 * name, one of its words, or its initials ("hpe" for Hewlett Packard
 * Enterprise). An apply link can point to a parent company's board (a game
 * studio's roles on its owner's Workday board); searching that board under the
 * studio's name would label the owner's roles as the studio's, and could
 * wrongly show a connection there. Boards found by lookup are checked against
 * the name the board reports instead, and boards entered by hand are trusted.
 */
const MINOR_WORDS = new Set(['and', 'of', 'the', 'for', 'at', 'in', 'de']);
function plausibleOwner(entry) {
  if (!entry || !entry.board) return false;
  if (entry.source !== 'apply_link') return true;
  const id = boardId(entry.ats, entry.board).toLowerCase().replace(/[^a-z0-9]/g, '');
  const words = companyWords(entry.company).filter(w => !MINOR_WORDS.has(w));
  const key = words.join('');
  const initials = words.map(w => w[0]).join('');
  return (key && (id.includes(key) || key.includes(id))) ||
         words.some(w => w.length >= 3 && id.includes(w)) ||
         (initials.length >= 2 && id.includes(initials));
}

// Systems whose board identifiers carry no company name (an Oracle board is
// a server name like "eeho.fa.us2.oraclecloud.com"), so plausibleOwner()
// cannot judge them.
const OPAQUE_IDS = new Set(['oracle']);

/**
 * Whether a company's board on record is its own, to be searched under its
 * name. A board learned from an apply link must plausibly be the company's
 * (plausibleOwner); where the identifier says nothing, it must not be on
 * record for another company too.
 */
function ownsBoard(kb, entry) {
  if (!entry || !entry.board) return false;
  if (entry.source !== 'apply_link') return true;
  if (OPAQUE_IDS.has(entry.ats)) {
    return !Object.values(kb.boards).some(e => e.key !== entry.key && sameBoard(e, entry));
  }
  return plausibleOwner(entry);
}

/** Board-name guesses for a company name: "acmerobotics", "acme-robotics". */
function guessSlugs(company) {
  const words = companyWords(company);
  return [...new Set([words.join(''), words.join('-')])].filter(Boolean);
}

// ── Polite requests ─────────────────────────────────────────────────────────

const GAP_MS = 500;
let lastRequest = 0;

function sleep(ms, signal) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * fetch, at least GAP_MS after the previous lookup request, with a timeout. One
 * retry on 429/5xx. A request that fails throws with the address in err.url.
 */
async function politeGet(url, signal, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastRequest + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait, signal);
    if (signal?.aborted) throw new Error('canceled');
    lastRequest = Date.now();
    const timeout = AbortSignal.timeout(15000);
    let r;
    try {
      r = await fetch(url, {
        redirect: 'follow',
        ...opts,
        headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      if (err && typeof err === 'object' && !err.url) err.url = url;
      throw err;
    }
    if ((r.status === 429 || r.status >= 500) && attempt === 0) { await sleep(1000, signal); continue; }
    return r;
  }
  return null;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function htmlTitle(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html || '');
  return m ? decodeEntities(m[1]).trim() : '';
}

// ── Board names, as each system reports them ────────────────────────────────
// Each returns the company name the board reports, or null when there is no
// such board. Throws on a network failure, so a failure is never read as
// "no board".

const BOARD_NAME = {
  // The board API returns { name, content }.
  async greenhouse(slug, signal) {
    const r = await politeGet(`${GH_API}/${encodeURIComponent(slug)}`, signal);
    if (!r || r.status !== 200) return null;
    const data = await r.json().catch(() => null);
    return data && typeof data.name === 'string' ? data.name : null;
  },
  // The hosted board page is titled with the company name ("Spotify"); an
  // unknown board name answers 404.
  async lever(slug, signal) {
    const r = await politeGet(`https://jobs.lever.co/${encodeURIComponent(slug)}`, signal);
    if (!r || r.status !== 200) return null;
    return htmlTitle(await r.text()) || null;
  },
  // The hosted board page is titled "{Company} Jobs"; an unknown board name
  // still answers 200, titled just "Jobs".
  async ashby(slug, signal) {
    const r = await politeGet(`https://jobs.ashbyhq.com/${encodeURIComponent(slug)}`, signal);
    if (!r || r.status !== 200) return null;
    return htmlTitle(await r.text()).replace(/\s*\bjobs$/i, '').trim() || null;
  },
  // The job list widget names the account ({ name, jobs }).
  async workable(slug, signal) {
    const r = await politeGet(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`, signal);
    const data = r && r.status === 200 ? await r.json().catch(() => null) : null;
    return data && typeof data.name === 'string' ? data.name : null;
  },
  // The job list does not name the company; each posting does (companyName),
  // so a board with no postings cannot be confirmed.
  async rippling(slug, signal) {
    const api = `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`;
    const r = await politeGet(api, signal);
    const list = r && r.status === 200 ? await r.json().catch(() => null) : null;
    if (!Array.isArray(list) || !list[0] || !list[0].uuid) return null;
    const d = await politeGet(`${api}/${encodeURIComponent(list[0].uuid)}`, signal);
    const job = d && d.status === 200 ? await d.json().catch(() => null) : null;
    return job && typeof job.companyName === 'string' ? job.companyName : null;
  },
  // The hosted board page is titled "{Company} Careers".
  async gem(slug, signal) {
    const r = await politeGet(`https://jobs.gem.com/${encodeURIComponent(slug)}`, signal);
    if (!r || r.status !== 200) return null;
    return htmlTitle(await r.text()) || null;
  },
};

// Whether a board has at least one posting: true or false, throwing when the
// board cannot be asked. Some systems let anyone open an account under any
// name, so a board named after a company proves nothing until it lists a job.
async function postingsAt(url, list, signal, opts) {
  const r = await politeGet(url, signal, opts);
  if (!r || r.status >= 500 || r.status === 429) {
    throw Object.assign(new Error(`no answer from ${url}`), { url, code: r ? `HTTP ${r.status}` : 'no answer' });
  }
  const data = r.status === 200 ? await r.json().catch(() => null) : null;
  const jobs = list(data);
  return Array.isArray(jobs) && jobs.length > 0;
}
const HAS_POSTINGS = {
  greenhouse: (slug, signal) => postingsAt(`${GH_API}/${encodeURIComponent(slug)}/jobs`, d => d && d.jobs, signal),
  lever: (slug, signal) => postingsAt(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=1`, d => d, signal),
  // The same job list query the Ashby scraper makes.
  ashby: (slug, signal) => postingsAt('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams',
    d => d?.data?.jobBoardWithTeams?.jobPostings, signal, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName: 'ApiJobBoardWithTeams', variables: { organizationHostedJobsPageName: slug },
        query: 'query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) { jobPostings { id } } }' }),
    }),
  workable: (slug, signal) => postingsAt(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`, d => d && d.jobs, signal),
  gem: (slug, signal) => postingsAt(`https://api.gem.com/job_board/v0/${encodeURIComponent(slug)}/job_posts/`, d => d, signal),
};

// Whether a name a board reports is this company's: the same after cleanup,
// or after dropping words a careers page puts around it ("Careers at Netflix",
// "BigPanda Careers").
const AROUND_NAME = new Set(['careers', 'career', 'jobs', 'job', 'at', 'join', 'us', 'work', 'with', 'openings',
  'opportunities', 'home', 'page', 'board']);
function namesCompany(reported, key) {
  if (!reported) return false;
  return companyKey(reported) === key || companyWords(reported).filter(w => !AROUND_NAME.has(w)).join('') === key;
}

// A guessed Eightfold address ({name}.eightfold.ai) that does not exist is an
// answer ("no board here"), not a network failure.
async function getIfThere(url, signal) {
  try { return await politeGet(url, signal); }
  catch (err) { if (!signal?.aborted && err?.cause?.code === 'ENOTFOUND') return null; throw err; }
}

// Why a lookup could not finish, "host (reason)", kept as lookup_error.
function failureNote(err) {
  let host = '';
  try { host = new URL(err?.url).hostname; } catch { /* no address */ }
  const why = err?.code || err?.cause?.code || (err?.name && err.name !== 'Error' && err.name !== 'TypeError' ? err.name : '') || 'no answer';
  return host ? `${host} (${why})` : why;
}
const jsonOf = r => (r && r.status === 200 ? r.json().catch(() => null) : null);

// An Eightfold site's postings, from its older job list, or from its newer one
// (PCSX) on a site that refuses the older; null when it answers neither.
// get(url) returns the JSON at url, or null.
async function eightfoldList(origin, domain, get) {
  const d = encodeURIComponent(domain);
  const older = await get(`${origin}/api/apply/v2/jobs?domain=${d}&num=1`);
  if (older && Array.isArray(older.positions)) return older.positions;
  const newer = await get(`${origin}/api/pcsx/search?domain=${d}&query=&location=&start=0`);
  return newer && Array.isArray(newer.data?.positions) ? newer.data.positions : null;
}

/**
 * The systems a board is guessed on from a company name, most common first.
 * Each gives the identifiers to try for a company, the board an identifier
 * stands for, and how to ask that board which company it belongs to (the
 * name, or null when there is no such board; throws on a network failure).
 * A board whose name matches counts only once it lists a posting: postings,
 * when given, asks that with one more request; the other systems' names are
 * read from a posting. requests is how many requests asking the name takes,
 * for lookupSeconds().
 */
const GUESSES = [
  ...['greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'gem'].map(ats => ({
    ats, ids: guessSlugs, board: slug => ({ slug }), name: BOARD_NAME[ats], postings: HAS_POSTINGS[ats], requests: 1,
  })),
  // {name}.eightfold.ai, whose careers page is titled with the company's name;
  // kept only when its job list for the domain {name}.com has a posting.
  { ats: 'eightfold', requests: 3,
    ids: company => { const k = companyWords(company).join(''); return k ? [k] : []; },
    board: sub => ({ base_url: `https://${sub}.eightfold.ai`, domain: `${sub}.com` }),
    name: async (sub, signal) => {
      const page = await getIfThere(`https://${sub}.eightfold.ai/careers`, signal);
      if (!page || page.status !== 200) return null;
      const title = htmlTitle(await page.text());
      const list = await eightfoldList(`https://${sub}.eightfold.ai`, `${sub}.com`, async u => jsonOf(await getIfThere(u, signal)));
      return list && list.length ? title || null : null;
    } },
];

// Roughly how long lookup() takes for a company with no known board: the
// requests for every guess, one after another. Each takes the 500 ms gap or
// the site's reply time, whichever is longer.
const SECONDS_PER_REQUEST = 0.75;
function lookupSeconds(company) {
  return GUESSES.reduce((n, g) => n + g.ids(company).length * g.requests, 0) * SECONDS_PER_REQUEST;
}

// ── Careers page scan ───────────────────────────────────────────────────────

const BOARD_LINK_RE = /(?:https?:)?\/\/[a-z0-9.-]+\.(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|gem\.com|rippling\.com|workable\.com|eightfold\.ai|oraclecloud\.com)[^\s"'<>\\)]*/gi;

/**
 * The first public job board linked or embedded in a page: { ats, board } or
 * null. The page's own address counts, so a board link given as the careers
 * page works too.
 */
function boardInPage(finalUrl, html) {
  const own = boardFromUrl(finalUrl);
  if (own) return own;
  const text = String(html || '').slice(0, 400000).replace(/\\\//g, '/');
  for (const m of text.matchAll(BOARD_LINK_RE)) {
    const found = boardFromUrl(m[0].startsWith('//') ? 'https:' + m[0] : decodeEntities(m[0]));
    if (found) return found;
  }
  // A Workday link with no site in it: the tenant is usually also the site.
  const wd = /https?:\/\/([a-z0-9][a-z0-9_-]*)\.wd\d+\.myworkdayjobs\.com/i.exec(text);
  if (wd) return { ats: 'workday', board: { base_url: wd[0].toLowerCase(), tenant: wd[1].toLowerCase(), site: wd[1].toLowerCase() } };
  return null;
}

async function scanCareersPage(careersUrl, signal) {
  const r = await politeGet(careersUrl, signal);
  if (!r || r.status !== 200) return null;
  const found = boardInPage(r.url || careersUrl, await r.text());
  // Confirm a Greenhouse, Lever, or Ashby board exists before keeping it.
  if (!found || !['greenhouse', 'lever', 'ashby'].includes(found.ats)) return found;
  return (await BOARD_NAME[found.ats](found.board.slug, signal)) ? found : null;
}

/**
 * Whether a company's own careers site is an iCIMS or Eightfold career site,
 * by asking the address each serves its job list from: { ats, board } or
 * null. kinds limits which are asked; domain is the Eightfold domain, when
 * known (siteDomain() otherwise). Throws on a network failure.
 */
async function probeCareersSite(origin, { kinds = ['icims', 'eightfold'], domain = '' } = {}, signal) {
  const json = async url => {
    const r = await politeGet(url, signal);
    return r && r.status === 200 ? r.json().catch(() => null) : null;
  };
  for (const kind of kinds) {
    if (kind === 'icims') {
      const data = await json(`${origin}/api/jobs?limit=1`);
      if (data && Array.isArray(data.jobs)) return { ats: 'icims', board: { base_url: origin } };
    }
    if (kind === 'eightfold') {
      const d = domain || siteDomain(hostOf(origin));
      if (await eightfoldList(origin, d, json)) return { ats: 'eightfold', board: { base_url: origin, domain: d } };
    }
  }
  return null;
}

// ── Known boards file ───────────────────────────────────────────────────────

class KnownBoards {
  /**
   * dir is the app data folder. Opening it moves the Workday URL cache JobSift
   * 3.0 keeps (workday_urls_cache.json) into the file and deletes that cache.
   */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, FILE);
    this.boards = {};
    this.facts = {};
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && typeof data.boards === 'object') this.boards = data.boards;
      if (data && data.facts && typeof data.facts === 'object') this.facts = data.facts;
    } catch { /* first use */ }
    // A careers site is only ever one JobSift cannot read and not a contractor
    // platform (see careersSiteFromUrl); a fact naming any other site is
    // dropped, and the company's apply links show its board on the next search.
    const notCareersSite = host => [...READABLE_DOMAINS, ...CONTRACTOR_PLATFORMS].some(d => onDomain(host, d));
    for (const f of Object.values(this.facts)) {
      if (f && f.careers_site && notCareersSite(String(f.careers_site.host || ''))) delete f.careers_site;
    }
    this.migrateWorkdayCache();
  }

  migrateWorkdayCache() {
    const old = path.join(this.dir, OLD_WORKDAY_CACHE);
    let cache;
    try { cache = JSON.parse(fs.readFileSync(old, 'utf8')); } catch { return; }
    for (const [company, info] of Object.entries(cache || {})) {
      if (!info || !info.base_url || !info.tenant || !info.site) continue;
      this.put({ company, ats: 'workday', board: { base_url: info.base_url, tenant: info.tenant, site: info.site },
                 source: 'careers_page', status: 'ok', confirmed_at: null });
    }
    this.save();
    fs.rmSync(old, { force: true });
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, boards: this.boards, facts: this.facts }, null, 2), 'utf8');
  }

  get(company) {
    return this.boards[companyKey(company)] || null;
  }

  /**
   * The other facts on record for a company, or {}:
   *   careers_site     { system, host, probe? }: where its apply links lead
   *                    when JobSift cannot read that site
   *   lookup_failed_at the last lookup that could not reach the job sites;
   *                    cleared by the next lookup that does
   *   lookup_error     which site it could not reach and why (failureNote), for
   *                    troubleshooting
   *   shared           { ats, board, confirmed_at }: roles that name this
   *                    company were found on that board, shared with another
   *   guessed_on       the systems its name was tried on, the last time no
   *                    board was found (see isDue)
   *   probed_site      the careers_site host asked the last time no board was
   *                    found (see isDue)
   */
  factsFor(company) {
    return this.facts[companyKey(company)] || {};
  }

  note(company, fields) {
    const key = companyKey(company);
    if (!key) return;
    const cur = this.facts[key] || { company };
    for (const [k, v] of Object.entries(fields)) { if (v == null) delete cur[k]; else cur[k] = v; }
    if (Object.keys(cur).length > 1) this.facts[key] = cur; else delete this.facts[key];
  }

  /**
   * Records what was learned about a company's board, following these rules:
   *   - a manual entry is only ever replaced by another manual entry
   *   - "no board found" never replaces a board: a stale board stays on record
   *     with a recheck date
   *   - an apply link does not replace a board that is still answering
   * Returns the entry as stored.
   */
  put({ company, ats = null, board = null, source, status, confirmed_at = new Date().toISOString(), recheck_after = null },
      { force = false } = {}) {
    const key = companyKey(company);
    if (!key || !SOURCES.includes(source)) return null;
    const cur = this.boards[key];
    const next = { company, key, ats, board, source, status, confirmed_at, recheck_after };
    if (cur) {
      if (cur.source === 'manual' && source !== 'manual' && !force) return cur;
      if (sameBoard(cur, next)) {
        // Same board again: refresh the status, keep where it first came from
        // unless the user has now entered it by hand.
        Object.assign(cur, { status, confirmed_at: confirmed_at || cur.confirmed_at,
                             recheck_after: recheck_after ?? cur.recheck_after,
                             source: source === 'manual' ? 'manual' : cur.source });
        return cur;
      }
      if (status === 'none' && cur.board) {
        cur.recheck_after = recheck_after;
        return cur;
      }
      if (source === 'apply_link' && cur.status === 'ok' && cur.board) return cur;
    }
    this.boards[key] = next;
    return next;
  }

  /** After a search: 'ok' when the board answered, 'stale' when it did not exist. */
  markSearched(company, ats, board, outcome) {
    const cur = this.get(company);
    if (!cur || !sameBoard(cur, { ats, board })) return;
    cur.status = outcome;
    if (outcome === 'ok') { cur.confirmed_at = new Date().toISOString(); cur.recheck_after = null; }
  }

  /** Whether a company should be looked up (again). */
  isDue(company, now = Date.now()) {
    const cur = this.get(company);
    if (!cur) return true;
    if (cur.status === 'ok') return false;
    // A company whose last lookup did not try every system in GUESSES is
    // looked up again, without waiting for its recheck date.
    if (cur.status === 'none' && !cur.board) {
      const tried = this.factsFor(company).guessed_on || [];
      if (GUESSES.some(g => !tried.includes(g.ats))) return true;
    }
    // So is one whose apply links have since led to a careers site not yet asked.
    const f = this.factsFor(company);
    const site = askableSite(company, f.careers_site);
    if (cur.status === 'none' && site && f.probed_site !== site.host) return true;
    return !cur.recheck_after || Date.parse(cur.recheck_after) <= now;
  }

  /**
   * Records the boards in the config as manual entries, so that they win over
   * learned ones and their status can be shown. Companies found by a careers
   * page link are recorded when the page is scanned.
   */
  syncFromConfig(cfg) {
    const ab = cfg.ats_boards || {};
    // A board the user has since removed from the config is no longer theirs
    // to protect: it stays on record, but a lookup or apply link may replace it.
    const rows = boardsFromConfig(ab);
    const inConfig = new Set(rows.map(r => companyKey(r.company)));
    for (const e of Object.values(this.boards)) {
      if (e.source === 'manual' && !inConfig.has(e.key)) e.source = 'lookup';
    }
    for (const { company, ats, board: b } of rows) {
      const board = b.slug ? { slug: b.slug.toLowerCase() } : b;
      const cur = this.get(company);
      const known = cur && sameBoard(cur, { ats, board });
      this.put({ company, ats, board, source: 'manual', status: known ? cur.status : 'ok',
                 confirmed_at: known ? cur.confirmed_at : null });
    }
  }
}

// ── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Finds a company's public job board.
 *   opts.careersUrl   a careers page to scan (step 3), optional
 *   opts.explicit     the user asked (the "Add" button): look again even if the
 *                     company is on record as having no public board, and let
 *                     what is found replace a board entered by hand
 *   opts.skipKnown    go straight to the guesses, ignoring a board on record
 *                     (used for a board that may be a parent company's)
 *   opts.recheckDays  when to look again after finding nothing
 * Returns { found, entry, step } where step is 'known', 'guess', 'careers_page',
 * 'careers_site' or 'none'. Every result, found or not, is recorded in kb (not saved).
 * Throws only when canceled.
 */
async function lookup(company, kb, { careersUrl = '', explicit = false, skipKnown = false, recheckDays = DEFAULT_RECHECK_DAYS, signal } = {}) {
  const key = companyKey(company);
  if (!key) return { found: false, entry: null, step: 'none' };

  // 1. Known boards.
  const cur = kb.get(company);
  if (cur && cur.status === 'ok' && cur.board && !skipKnown) return { found: true, entry: cur, step: 'known' };
  // A board the user entered by hand is never replaced by a guess, even when
  // it has stopped answering; the user fixes it on the Sources tab.
  if (cur && cur.source === 'manual' && !explicit) return { found: false, entry: cur, step: 'known' };
  if (cur && cur.status === 'none' && !explicit && !careersUrl && !kb.isDue(company)) {
    return { found: false, entry: cur, step: 'known' };
  }

  let failed = null;   // a network failure is not evidence of "no board"; failureNote() of the first
  const record = (ats, board, source) =>
    kb.put({ company, ats, board, source, status: 'ok' }, { force: explicit });

  // 2. Guess from the name: kept only when the board reports the same company
  // and lists a posting.
  for (const g of GUESSES) {
    for (const id of g.ids(company)) {
      if (signal?.aborted) throw new Error('canceled');
      let named = false;
      try { named = namesCompany(await g.name(id, signal), key) && (!g.postings || await g.postings(id, signal)); }
      catch (err) { if (signal?.aborted) throw new Error('canceled'); failed = failed || failureNote(err); }
      if (named) {
        kb.note(company, { lookup_failed_at: null, lookup_error: null });
        return { found: true, entry: record(g.ats, g.board(id), 'lookup'), step: 'guess' };
      }
    }
  }

  // 3. Careers page scan, then whether the page's site is a career site that
  // serves its jobs as data.
  if (careersUrl) {
    try {
      const hit = await scanCareersPage(careersUrl, signal) ||
                  await probeCareersSite(new URL(careersUrl).origin.toLowerCase(), {}, signal);
      if (hit) {
        kb.note(company, { lookup_failed_at: null, lookup_error: null });
        return { found: true, entry: record(hit.ats, hit.board, 'careers_page'), step: 'careers_page' };
      }
    } catch (err) { if (signal?.aborted) throw new Error('canceled'); failed = failed || failureNote(err); }
  }

  // 4. The careers site the company's apply links lead to (see askableSite):
  // its main page scanned for a board link, and asked whether it is an iCIMS
  // or Eightfold career site when its links look like one.
  const site = askableSite(company, kb.factsFor(company).careers_site);
  if (site) {
    try {
      const hit = (ownSite(company, site.host) && await scanCareersPage(`https://${site.host}/`, signal)) ||
                  (site.probe && await probeCareersSite(`https://${site.host}`, { kinds: [site.probe] }, signal)) || null;
      if (hit) {
        kb.note(company, { lookup_failed_at: null, lookup_error: null });
        return { found: true, entry: record(hit.ats, hit.board, 'apply_link'), step: 'careers_site' };
      }
    } catch (err) { if (signal?.aborted) throw new Error('canceled'); failed = failed || failureNote(err); }
  }

  if (failed) {
    kb.note(company, { lookup_failed_at: new Date().toISOString(), lookup_error: failed });
    return { found: false, entry: cur, step: 'none', error: true };
  }
  kb.note(company, { lookup_failed_at: null, lookup_error: null, guessed_on: GUESSES.map(g => g.ats), probed_site: site ? site.host : null });
  const recheck_after = new Date(Date.now() + recheckDays * DAY_MS).toISOString();
  const entry = cur && cur.board
    ? kb.put({ company, ats: cur.ats, board: cur.board, source: cur.source, status: cur.status, recheck_after })
    : kb.put({ company, source: 'lookup', status: 'none', recheck_after });
  return { found: false, entry, step: 'none' };
}

/** "Found on Greenhouse (acme)." or the not-found message, for the user. */
function describe(company, result) {
  if (result.found) return `Found on ${SYSTEMS[result.entry.ats]} (${boardId(result.entry.ats, result.entry.board)}).`;
  if (result.error) return `Couldn't reach the job boards to look up ${company}. Check your connection and try again.`;
  return `Couldn't find a public job board for ${company}. Add it manually with its board link.`;
}

// ── Coverage ────────────────────────────────────────────────────────────────

/**
 * How a company's jobs are found, as one status for the Connections tab:
 * { kind, ...details }. The first that applies wins:
 *   skipped    the name is a placeholder, not an employer ("Freelance")
 *   ok         its own board is searched every run              { ats, board }
 *   shared_ok  its roles were found on a board it shares with another
 *              company, and are searched there                   { ats, board }
 *   stale      its board stopped answering; looked up again      { ats, board, manual }
 *   shared     its apply links lead to a board that may belong to another
 *              company, and no role naming it has been found there yet
 *                                                                { ats, board }
 *   elsewhere  its apply links lead to a careers site JobSift cannot read
 *   none       looked up, and no board was found
 *   failed     the last lookup could not reach the job sites
 *   not_yet    not looked up yet
 */
function coverage(kb, company) {
  if (notACompany(company)) return { kind: 'skipped' };
  const e = kb.get(company);
  const f = kb.factsFor(company);
  const at = e && e.board ? { ats: e.ats, board: boardId(e.ats, e.board) } : {};
  if (e && e.board && e.status === 'ok') {
    if (ownsBoard(kb, e)) return { kind: 'ok', ...at };
    const confirmed = f.shared && sameBoard(f.shared, e);
    return { kind: confirmed ? 'shared_ok' : 'shared', ...at };
  }
  if (e && e.board && e.status === 'stale') return { kind: 'stale', ...at, manual: e.source === 'manual' };
  if (f.careers_site) return { kind: 'elsewhere' };
  if (e && e.status === 'none') return { kind: 'none' };
  if (f.lookup_failed_at) return { kind: 'failed' };
  return { kind: 'not_yet' };
}

/**
 * Whether the next run that searches the connections' companies looks this
 * company up by name. A board that may be another company's is looked up
 * again on its recheck date, in case the company has its own board after all.
 */
function lookupDue(kb, company, now = Date.now()) {
  if (notACompany(company)) return false;
  const e = kb.get(company);
  if (e && e.status === 'ok' && e.board && !ownsBoard(kb, e)) return !e.recheck_after || Date.parse(e.recheck_after) <= now;
  return kb.isDue(company, now);
}

// ── Checking the connections' companies ─────────────────────────────────────

/**
 * Sorts the connections' companies by how their jobs can be searched, first
 * looking up every company that is due (see lookupDue), most connections
 * first. Used by each search, and by the Connections tab's check button.
 *   companies   connections.companiesByCount()
 *   opts.skip   company keys to leave out (the user's own boards)
 *   opts.onProgress(n, total) before each lookup
 *   opts.onChecked(company)   after each lookup, once its result is recorded
 * Returns { own, shared, looked, found }: own and shared are the boards to
 * search, as [{ company, ats, board }]; a shared board may be another
 * company's, so only its roles that name the company count. Stops early,
 * without throwing, when canceled.
 */
async function checkCompanies(kb, companies, { skip = new Set(), recheckDays = DEFAULT_RECHECK_DAYS, signal, onProgress, onChecked } = {}) {
  const own = [], shared = [];
  const sharedEntry = name => {
    const e = kb.get(name);
    return e && e.status === 'ok' && e.board && !ownsBoard(kb, e) ? e : null;
  };
  const toLookUp = [];
  for (const c of companies) {
    if (skip.has(c.key) || notACompany(c.name)) continue;
    const e = kb.get(c.name);
    if (e && e.status === 'ok' && e.board && !sharedEntry(c.name)) { own.push({ company: e.company, ats: e.ats, board: e.board }); continue; }
    if (lookupDue(kb, c.name)) toLookUp.push(c);
    else if (sharedEntry(c.name)) { const s = sharedEntry(c.name); shared.push({ company: c.name, ats: s.ats, board: s.board }); }
  }
  let looked = 0, found = 0;
  for (const c of toLookUp) {
    if (signal?.aborted) break;
    looked++;
    if (onProgress) onProgress(looked, toLookUp.length);
    const before = sharedEntry(c.name);
    try {
      const res = await lookup(c.name, kb, { recheckDays, signal, skipKnown: !!before });
      if (res.found && !(before && sameBoard(res.entry, before))) {
        own.push({ company: res.entry.company, ats: res.entry.ats, board: res.entry.board }); found++;
      } else if (before) shared.push({ company: c.name, ats: before.ats, board: before.board });
    } catch { break; }   // canceled
    if (onChecked) onChecked(c.name);
  }
  return { own, shared, looked, found };
}

// ── Learning from apply links ───────────────────────────────────────────────

/**
 * Records the board behind every apply link that points to Greenhouse, Lever,
 * Ashby, or Workday, and for other links the careers site they lead to (see
 * careersSiteFromUrl; ignore is passed on to it). keep(record) decides which
 * postings count (the caller passes only postings made by the employer itself,
 * so a reposting site or a staffing firm is never recorded as owning someone
 * else's board). Returns the companies whose board was newly learned.
 */
function learnFromApplyLinks(records, kb, keep = () => true, ignore = []) {
  const learned = new Set();
  for (const rec of records || []) {
    const company = String(rec.company || '').trim();
    const url = rec.ats_url || rec.apply_url;
    if (!company || !url || !keep(rec)) continue;
    const hit = boardFromUrl(url);
    if (!hit) {
      const site = careersSiteFromUrl(url, ignore);
      if (site) kb.note(company, { careers_site: site });
      continue;
    }
    const before = kb.get(company);
    const after = kb.put({ company, ats: hit.ats, board: hit.board, source: 'apply_link', status: 'ok' });
    if (after && !sameBoard(before, after)) learned.add(company);
  }
  return [...learned];
}

module.exports = {
  KnownBoards, lookup, lookupSeconds, lookupDue, checkCompanies, coverage, describe, boardFromUrl, boardId,
  boardsFromConfig, siteDomain, learnFromApplyLinks,
  SYSTEMS, SLUG_SYSTEMS, BOARD_FIELDS, DEFAULT_RECHECK_DAYS,
};
