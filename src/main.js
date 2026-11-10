'use strict';

/**
 * src/main.js
 * App entry point. Manages tray, windows, IPC, pipeline orchestration,
 * and the setTimeout-based scheduler.
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, session, Notification, shell, dialog,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

const cfgModule  = require('./config');
const { RULES, searchPlan } = require('./criteria');
const scheduler  = require('./scheduler');
const connections = require('./connections');
const applied = require('./applied');
const history = require('./history');
const runlog = require('./runlog');
const { newListings } = require('./sources');
const boards     = require('./boards');

// A fingerprint of the code that judges roles, saved with each run's results,
// so a run can tell whether an earlier run judged its roles the same way.
const EVALUATOR_ID = (() => {
  const hash = crypto.createHash('sha256');
  for (const f of ['eval.js', 'criteria.js', 'sources.js']) hash.update(fs.readFileSync(path.join(__dirname, f)));
  return hash.digest('hex').slice(0, 16);
})();

// Force the app name so the userData directory is ALWAYS %APPDATA%/JobSift,
// regardless of how the app is launched. When launched as `electron .` the name
// comes from package.json (JobSift), but launching the script directly (e.g. some
// VS Code debug configs) or other entry points can fall back to "Electron",
// which would point at a different userData folder with no config. Setting it
// explicitly here (before 'ready') keeps config and data in one place.
app.setName('JobSift');
// Required on Windows for native notifications to be attributed to this app.
app.setAppUserModelId('com.jobsift.app');

// ── Runtime footprint trimming ────────────────────────────────────────────────
// This app only renders local HTML and scrapes pages in hidden windows; it has
// no use for GPU acceleration or Chromium's privacy-sandbox databases. Disabling
// them keeps the userData directory small: it drops the GPUCache,
// DawnGraphiteCache and DawnWebGPUCache shader caches (~1.6 MB) and prevents the
// DIPS, Trust Token, Shared Storage and Shared Dictionary stores from being
// created. Must run before app 'ready', so it lives here at module load.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch(
  'disable-features',
  'DIPS,PrivateStateTokens,TrustTokens,SharedStorageAPI,CompressionDictionaryTransport',
);
// Stop the on-disk caches from growing at all: no GPU shader disk cache, and an
// effectively zero-size HTTP disk cache. Combined with disableHardwareAcceleration
// this prevents the GPUCache / DawnGraphiteCache / DawnWebGPUCache / Cache / Code
// Cache directories from accumulating data.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disk-cache-size', '0');

// ── Directory helpers ─────────────────────────────────────────────────────────

function evaluatedDir() {
  return path.join(app.getPath('userData'), 'Scrapes', 'Evaluated Scrapes');
}
// Intermediate folder for the raw per-source dumps, which later runs reuse
// (see history.js), and the transient merged file (deleted on a successful run).
function stagingDir() {
  return path.join(app.getPath('userData'), 'Scrapes', 'Raw Scrape Staging');
}
// One small log per run (see runlog.js).
function logsDir() {
  return path.join(app.getPath('userData'), 'Logs');
}
function rawDir() {
  return stagingDir();
}

function timestamp() {
  // Format: YYYY-MM-DD_HH-MM in the user's LOCAL time zone (not UTC), so the
  // filename matches the wall-clock time the run happened.
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
         `_${p(now.getHours())}-${p(now.getMinutes())}`;
}

// ── Connections and known boards ──────────────────────────────────────────────
// Both files live in the app data folder, never in the repo. One KnownBoards
// instance is shared by runs and by the config page, so a lookup made while a
// run is going is not overwritten when the run saves.

function dataDir() {
  return app.getPath('userData');
}

let _kb = null;
function knownBoards() {
  if (!_kb) _kb = new boards.KnownBoards(dataDir());
  return _kb;
}

// The fields of a role the applied records use, as strings, or null without an id.
function appliedRole(r) {
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  const s = v => (typeof v === 'string' ? v.slice(0, 2000) : '');
  return { id: s(r.id), company: s(r.company), role_title: s(r.role_title), apply_url: s(r.apply_url) };
}

// What the config page shows: counts, the import date, and each company with
// its board status. No person's name is included.
function connectionsSummary() {
  const data = connections.load(dataDir());
  if (!data) return null;
  const kb = knownBoards();
  const now = Date.now();
  let lookupCount = 0, lookupSeconds = 0;
  const companies = connections.companiesByCount(data.people).map(c => {
    if (boards.lookupDue(kb, c.name, now)) { lookupCount++; lookupSeconds += boards.lookupSeconds(c.name); }
    return { name: c.name, count: c.count, coverage: boards.coverage(kb, c.name) };
  });
  return {
    imported_at: data.imported_at, people_count: data.people.length, company_count: companies.length, companies,
    lookup_count: lookupCount, lookup_minutes: Math.ceil(lookupSeconds / 60),
  };
}

const MAX_CSV_BYTES = 50 * 1024 * 1024;

function importConnectionsText(text) {
  const people = connections.readLinkedInCsv(text);
  if (!people.length) throw new Error('No connections with a company were found in that file.');
  connections.save(dataDir(), people);
  return connectionsSummary();
}

const SCAN_LABELS = { 1: 'Past 24 hours', 3: 'Past 3 days', 7: 'Past week', 30: 'Past 30 days' };

// ── App state ─────────────────────────────────────────────────────────────────

let tray         = null;
let loginWin     = null;
let mainWin      = null;   // single app window (dashboard + config + wizard)
let scrapeAbort  = null;   // AbortController | null
let boardCheckAbort = null;   // AbortController of a running connections board check | null
let isQuitting   = false;
let lastDaysAgo  = 7;      // last-used scan period (days); persisted in config._lastDaysAgo
let passControl  = null;   // { abort: bool } - lets the user skip the current Jobright pass

// ── Preload path ──────────────────────────────────────────────────────────────

const PRELOAD = path.join(__dirname, '..', 'ui', 'preload.js');

// Window/taskbar icon (the same magnifier glyph used by the tray). In a packaged
// build the installer/desktop icon comes from electron-builder.yml; this sets the
// window and taskbar icon for dev runs and as a belt-and-suspenders in production.
const ICON_PATH = path.join(__dirname, '..', 'resources', 'icon.png');

// ── Window factory ────────────────────────────────────────────────────────────

function makeWin(opts = {}) {
  const win = new BrowserWindow({
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...opts,
  });
  // Hide to tray on close instead of destroying
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // Open external links (Apply buttons, any http/https link) in the user's
  // default browser rather than inside the app. Internal file:// navigation
  // (dashboard <-> config) is left alone.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:\/\//i.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  return win;
}

// ── Named window accessors ────────────────────────────────────────────────────

// Single application window. The dashboard, config, and wizard are all pages
// loaded into this one window (navigated either here or via window.location in
// the renderer), so only one app window can ever exist at a time.
function getMain() {
  if (!mainWin || mainWin.isDestroyed()) {
    mainWin = makeWin({ width: 1600, height: 900, minWidth: 1100, minHeight: 700, title: 'JobSift' });
  }
  return mainWin;
}

// Load a UI page into the single window and surface it. Skips a redundant reload
// if already on that page (unless a query string is requested, e.g. goto=schedule).
function showPage(rel, opts) {
  const win = getMain();
  const section = rel.split('/')[0].toLowerCase();
  const cur = (win.webContents.getURL() || '').toLowerCase();
  if (!cur.includes('/' + section + '/') || (opts && opts.search)) {
    win.loadFile(path.join(__dirname, '..', 'ui', rel), opts);
  }
  win.show();
  win.focus();
  return win;
}

function showDashboard()    { return showPage('dashboard/index.html'); }
function showConfig(opts)   { return showPage('config/index.html', opts); }

function getLogin() {
  if (!loginWin || loginWin.isDestroyed()) {
    // No preload - this window IS the Jobright.ai website
    loginWin = new BrowserWindow({
      width: 1024, height: 768,
      title: 'Sign in to Jobright.ai',
      icon: ICON_PATH,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    loginWin.loadURL('https://jobright.ai/');

    // Detect a successful login WITHOUT false positives. jobright.ai sets cookies
    // (including httpOnly ones) on the anonymous page before you sign in, so a
    // plain "do auth cookies exist" check fires immediately and wrongly. Instead
    // we snapshot the cookies that are present once the anonymous page has loaded
    // and settled, then watch only for a NEW session cookie that appears after
    // you actually authenticate. Pre-existing/anonymous cookies are baselined out.
    let _loginPoll = null;
    let _baseline  = null;   // Set<string> of cookie names present before sign-in
    const stopLoginPoll = () => { if (_loginPoll) { clearInterval(_loginPoll); _loginPoll = null; } };

    const liveJobrightCookies = async () => {
      try {
        const cs = await session.defaultSession.cookies.get({ domain: 'jobright.ai' });
        const now = Date.now() / 1000;
        return cs.filter(c => !c.expirationDate || c.expirationDate > now);
      } catch { return []; }
    };

    const startLoginPoll = async () => {
      stopLoginPoll();
      // Baseline = cookies present right now (anonymous visit). Anything new that
      // shows up later and looks like a session is treated as a successful login.
      _baseline = new Set((await liveJobrightCookies()).map(c => c.name));
      _loginPoll = setInterval(async () => {
        if (!loginWin || loginWin.isDestroyed()) { stopLoginPoll(); return; }
        const cs = await liveJobrightCookies();
        // New (not baselined) + passes the shared session-cookie test.
        const newSession = cs.some(c => !_baseline.has(c.name) && isSessionCookie(c));
        if (newSession) {
          stopLoginPoll();
          if (loginWin && !loginWin.isDestroyed()) loginWin.hide();
          showDashboard();
          broadcast('auth:loginComplete', {});
        }
      }, 1500);
    };

    // Take the baseline only after the anonymous page has loaded and its cookies
    // have settled, so the initial anonymous cookies do not count as a new login.
    loginWin.webContents.once('did-finish-load', () => {
      setTimeout(() => { if (loginWin && !loginWin.isDestroyed()) startLoginPoll(); }, 3000);
    });
    loginWin.on('hide', stopLoginPoll);
    loginWin.on('closed', () => { stopLoginPoll(); loginWin = null; });
  }
  return loginWin;
}

// ── Tray setup ────────────────────────────────────────────────────────────────

function setupTray() {
  const iconPath = path.join(__dirname, '..', 'resources', 'icon.png');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('JobSift');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => { showDashboard(); });
}

function buildTrayMenu() {
  const running = !!scrapeAbort;
  return Menu.buildFromTemplate([
    {
      label:   running ? 'Running... (click to cancel)' : 'Run Now',
      click:   running ? () => { if (scrapeAbort) scrapeAbort.abort(); }
                       : () => triggerScrape({ daysAgo: lastDaysAgo }),
    },
    { type: 'separator' },
    { label: 'Open Dashboard',     click: () => { showDashboard(); } },
    { label: 'Settings',           click: () => { showConfig(); } },
    { label: 'Configure Schedule', click: () => { showConfig({ search: 'goto=schedule' }); } },
    { label: 'Sign In',        click: () => { getLogin().show();     } },
    { label: 'Open Log Folder', click: () => { fs.mkdirSync(logsDir(), { recursive: true }); shell.openPath(logsDir()); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
    // Hovering the tray icon reflects whether a scrape (manual or scheduled) is running.
    tray.setToolTip(scrapeAbort ? 'JobSift: scraping in progress…' : 'JobSift');
  }
}

// ── Session / login check ─────────────────────────────────────────────────────

// jobright.ai stores its authenticated session in the httpOnly "SESSION_ID"
// cookie, which is present ONLY after sign-in (verified by cookie inspection).
// Match it precisely so analytics cookies such as ttcsid / _uetsid (which merely
// contain "sid") are never mistaken for a logged-in session.
const AUTH_COOKIE_RE = /^session[_-]?id$/i;
// Known analytics/marketing cookies that are set even when signed out and must
// NOT be treated as a session.
const ANALYTICS_COOKIE_RE = /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|_hj|ajs_|amplitude|mp_|_mkto|__stripe|_clck|_clsk|_uetsid|_uetvid|optimizely|hubspot|__hs|intercom)/i;

// One definition of "this cookie means a live Jobright session", shared by the
// post-login poller and the pre-run check. They must agree: if the poller
// accepted a cookie the pre-run check rejects, the login window would close and
// the dashboard open while the app still counted as signed out, and the next
// run would immediately re-prompt for sign-in.
function isSessionCookie(c) {
  const live = !c.expirationDate || c.expirationDate > Date.now() / 1000;
  return live && !ANALYTICS_COOKIE_RE.test(c.name) && AUTH_COOKIE_RE.test(c.name);
}

async function checkLoggedIn() {
  // Check for persisted Jobright session cookies in the default session.
  // Reliable across restarts (Electron stores cookies on disk in userData) and
  // avoids the SPA redirect problem that makes net.fetch unreliable.
  //
  // Signed in only if a non-expired cookie's NAME is the session token.
  // httpOnly is deliberately not a signal: jobright.ai sets httpOnly cookies on
  // the anonymous page before sign-in, so it would fire immediately and wrongly.
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: 'jobright.ai' });
    return cookies.some(isSessionCookie);
  } catch {
    return false;
  }
}

// ── Progress broadcast ────────────────────────────────────────────────────────

function broadcast(channel, payload) {
  if (channel === 'scrape:progress') runlog.progress(payload.step, payload.message);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, payload);
  }
}

// Unintrusive native OS notification (used for silent/background scheduled runs).
// onClick, if given, runs when the user clicks the notification.
function notify(title, body, onClick) {
  try {
    if (!Notification.isSupported || !Notification.isSupported()) return;
    const iconPath = path.join(__dirname, '..', 'resources', 'icon.png');
    const n = new Notification({
      title, body,
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      silent: false,
    });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch { /* notifications are best-effort */ }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

async function runPipeline(options) {
  const { daysAgo = 7, includeSeen = false, background = false } = options || {};
  const ts = timestamp();

  // Required here rather than at module load: these three pull in the scraping
  // and scoring stacks, and a run is the only thing that needs them. Keeping
  // them out of the startup path means launching to the tray stays fast.
  const jobrightScraper = require('./scraper/jobright');
  const atsScraper      = require('./scraper/ats-http');
  const evalEngine      = require('./eval');
  const { sourcesFromConfig, postedBy } = require('./sources');

  const cfg = cfgModule.load();

  runlog.open(logsDir(), ts);
  runlog.log(`JobSift ${app.getVersion()} run ${ts}: ${background ? 'scheduled' : 'started by hand'}, past ${daysAgo} day(s)` +
             `${includeSeen ? ', including roles already shown' : ''}; evaluator ${EVALUATOR_ID}, config version ${cfg.config_version}`);

  for (const d of [evaluatedDir(), stagingDir(), rawDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
  history.prune(rawDir());

  // Auth check
  broadcast('scrape:progress', { step: 'auth', message: 'Checking Jobright session...', pct: 2 });
  const loggedIn = await checkLoggedIn();
  if (!loggedIn) {
    if (background) {
      // Scheduled run: do not pop a window; prompt unintrusively via a notification.
      notify('JobSift', 'Sign in to Jobright to run the scheduled scrape.', () => getLogin().show());
    } else {
      getLogin().show();
    }
    broadcast('auth:required', {});
    throw new Error('__AUTH_REQUIRED__');  // sentinel: handled as a prompt, not an error
  }

  // ── Jobright (50% of progress budget) ─────────────────────────────────────
  broadcast('scrape:progress', { step: 'jobright', message: 'Launching Jobright scraper...', pct: 5 });

  // Per-source isolation: a failure in one source (e.g. a network timeout on a
  // search-page load) must not abort the whole run and discard the other source.
  // Earlier runs' saved results: what they accepted, and so already showed,
  // is left out of this run (see sources.newListings). includeSeen keeps it all.
  const priorRuns = [];
  if (!includeSeen && fs.existsSync(evaluatedDir())) {
    for (const f of fs.readdirSync(evaluatedDir()).filter(n => n.endsWith('.json'))) {
      try { priorRuns.push(JSON.parse(fs.readFileSync(path.join(evaluatedDir(), f), 'utf8'))); }
      catch { /* skip malformed files */ }
    }
  }
  const shown = new Set(priorRuns.filter(run => run?.evaluator === EVALUATOR_ID)
    .flatMap(run => (run.accepted?.roles || []).map(role => role.id)).filter(Boolean));

  // A scheduled run searches Jobright only as far back as the last completed
  // run, when the runs so far already cover the rest of its period with these
  // same settings (see history.daysToSearch).
  const started = Date.now();
  const settingsKey = history.settingsKey(cfg, EVALUATOR_ID);
  const covered = history.coverage(dataDir());
  const jobrightDays = background ? history.daysToSearch(covered, settingsKey, daysAgo, started) : daysAgo;
  if (jobrightDays < daysAgo) {
    console.log(`Jobright: searching the past ${jobrightDays} day(s); earlier runs cover the rest of the past ${daysAgo}`);
  }
  console.log(`Jobright: ${shown.size} roles already shown by earlier runs`);

  // Each run saves everything Jobright returned, closed postings included, so
  // later runs do not open any of it again; the postings are also saved one by
  // one as they are read, in case the run ends early.
  const earlier = history.jobright(rawDir());
  console.log(`Jobright: ${earlier.read.size} postings read and ${earlier.closed.size} found closed in the last ${history.KEEP_DAYS} days are on file`);
  const reads = history.partial(rawDir(), 'jobright', ts);
  const jobrightRequests = countRequests();
  let jobrightAll = [];
  let jobrightFailed = false;
  passControl = { abort: false };  // reset; the Abort Pass button flips abort=true
  try {
    const jobright = await jobrightScraper.run({
      cfg,
      daysAgo: jobrightDays,
      known: earlier.read,
      closed: earlier.closed,
      shown,
      onRead: record => reads.add(record),
      signal: scrapeAbort.signal,
      passControl,
      onProgress: (msg, pct, line) =>
        broadcast('scrape:progress', {
          step: 'jobright',
          message: msg,
          pct: 5 + Math.round(pct * 50),
          line,
        }),
    });
    jobrightAll = jobright.records;
    if (jobright.complete) history.saveCoverage(dataDir(), covered, settingsKey, jobrightDays, started);
    console.log(`Jobright: ${jobright.complete ? 'every search ran to its end' : 'not every search ran to its end, so the next scheduled run searches the whole period again'}`);
  } catch (err) {
    jobrightFailed = true;
    console.error('Jobright scraper failed:', err);
    broadcast('scrape:progress', {
      step: 'jobright',
      message: `Jobright step failed (${err.message}); continuing with ATS results`,
      pct: 55,
    });
  }
  // Every request the hidden windows made, by site and status. "cached" ones
  // were answered from the browser cache without asking the site.
  const made = jobrightRequests.stop();
  runlog.log(`Jobright requests: ${made.total()}`);
  for (const line of made.lines()) runlog.log(`  ${line}`);
  // The roles: every record but the closed postings.
  const jobrightRaw = jobrightAll.filter(r => !r.is_closed);

  // A step that failed outright keeps its partial file, the only record of
  // what it read.
  if (!jobrightFailed) {
    fs.writeFileSync(path.join(rawDir(), history.rawName('jobright', ts)), JSON.stringify(jobrightAll, null, 2), 'utf8');
    reads.remove();
  }
  broadcast('scrape:progress', {
    step: 'jobright',
    message: `Jobright: ${jobrightRaw.length} listings collected`,
    pct: 55,
  });

  // ── Known boards: learn from apply links ──────────────────────────────────
  // Jobright runs first, so a board learned from one of its apply links can be
  // searched directly in this same run. Only postings made by the employer
  // itself count: a reposting site or staffing firm does not own the board its
  // apply link points to.
  const kb = knownBoards();
  kb.syncFromConfig(cfg);
  try {
    const src = sourcesFromConfig(cfg);
    const learned = boards.learnFromApplyLinks(jobrightRaw, kb, rec => postedBy(rec, src).kind === 'employer',
                                               [...src.jobBoardLinks, ...src.staffingLinks]);
    kb.save();
    if (learned.length) {
      broadcast('scrape:progress', { step: 'ats', message: `Learned ${learned.length} company job boards from apply links`, pct: 56 });
    }
  } catch (err) {
    console.error('Learning boards from apply links failed:', err);
  }

  // The connections' companies, most connections first, when imported and the
  // user has turned on searching them.
  const people = (cfg.connections?.search_companies === true && connections.load(dataDir())?.people) || [];
  const connectionCompanies = connections.companiesByCount(people);

  // ── ATS HTTP (13% of progress budget) ─────────────────────────────────────
  broadcast('scrape:progress', { step: 'ats', message: 'Scraping ATS boards...', pct: 57 });

  let atsRaw = [];
  try {
    atsRaw = await atsScraper.run({
      cfg,
      kb,
      known: history.boards(rawDir()),
      connectionCompanies,
      signal: scrapeAbort.signal,
      onChecked: () => broadcast('connections:updated', connectionsSummary()),
      onProgress: (msg, pct) =>
        broadcast('scrape:progress', {
          step: 'ats',
          message: msg,
          pct: 57 + Math.round(pct * 13),
        }),
    });
  } catch (err) {
    console.error('ATS scraper failed:', err);
    broadcast('scrape:progress', {
      step: 'ats',
      message: `ATS step failed (${err.message}); continuing with what was collected`,
      pct: 70,
    });
  }
  try { kb.save(); } catch (err) { console.error('Saving known boards failed:', err); }

  fs.writeFileSync(path.join(rawDir(), history.rawName('ats-http', ts)), JSON.stringify(atsRaw, null, 2), 'utf8');
  broadcast('scrape:progress', {
    step: 'ats',
    message: `ATS: ${atsRaw.length} listings collected`,
    pct: 70,
  });

  // ── Merge + dedup ──────────────────────────────────────────────────────────
  broadcast('scrape:progress', { step: 'merge', message: 'Merging results...', pct: 72 });

  // Each posting once, leaving out what an earlier run already accepted with
  // this same evaluator (see sources.newListings).
  const merged = newListings([...jobrightRaw, ...atsRaw], priorRuns, EVALUATOR_ID);

  const mergePayload = {
    scraped_at: new Date().toISOString(),
    date:       ts.slice(0, 10),
    time:       ts.slice(11).replace('-', ':'),  // HH:MM, local time of the run
    days_ago:   daysAgo,
    scan_label: SCAN_LABELS[daysAgo] || `Past ${daysAgo} days`,
    results:    merged,
  };

  const mergePath = path.join(stagingDir(), `job-search-merge-${ts}.json`);
  fs.writeFileSync(mergePath, JSON.stringify(mergePayload, null, 2), 'utf8');
  broadcast('scrape:progress', {
    step: 'merge',
    message: `Merged: ${merged.length} new unique listings`,
    pct: 75,
  });

  // ── Eval ───────────────────────────────────────────────────────────────────
  broadcast('scrape:progress', { step: 'eval', message: 'Running scoring engine...', pct: 77 });
  const evaluated = await evalEngine.run(mergePayload, cfg);
  evaluated.evaluator = EVALUATOR_ID;

  // ── Save output ────────────────────────────────────────────────────────────
  broadcast('scrape:progress', { step: 'save', message: 'Saving results...', pct: 95 });
  const outputPath = path.join(evaluatedDir(), `job-search-${ts}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(evaluated, null, 2), 'utf8');

  // Delete staging file on success
  try { fs.unlinkSync(mergePath); } catch { /* ignore */ }

  const counts = {
    accepted: evaluated.accepted?.roles?.length ?? 0,
    rejected: evaluated.rejected?.roles?.length ?? 0,
  };

  broadcast('scrape:progress', {
    step: 'done',
    message: `Done - ${counts.accepted} accepted, ${counts.rejected} rejected`,
    pct: 100,
  });

  return { outputPath, counts };
}

// Counts every web request made through the app's browser session until
// stop() is called, which returns the count (a runlog.tally). During the
// Jobright step these are the requests of the hidden Jobright windows.
function countRequests() {
  const made = runlog.tally();
  const web = session.defaultSession.webRequest;
  const isWeb = url => /^https?:/i.test(url);
  web.onCompleted(d => { if (isWeb(d.url)) made.count(d.url, d.fromCache ? 'cached' : d.statusCode); });
  web.onErrorOccurred(d => { if (isWeb(d.url)) made.count(d.url, 'failed'); });
  return { stop() { web.onCompleted(null); web.onErrorOccurred(null); return made; } };
}

// ── Trigger scrape (used by tray and IPC handler) ─────────────────────────────

async function triggerScrape(options) {
  if (scrapeAbort) return;  // already running
  // A search checks the connections' job boards itself, so a check started on
  // the Connections tab stops here; what it found so far is kept.
  if (boardCheckAbort) boardCheckAbort.abort();
  if (options && typeof options.daysAgo === 'number') {
    lastDaysAgo = options.daysAgo;
    try { const c = cfgModule.load(); c._lastDaysAgo = lastDaysAgo; cfgModule.save(c); } catch { /* ignore */ }
  }
  const background = !!(options && options.background);
  scrapeAbort = new AbortController();
  refreshTrayMenu();
  // Foreground runs surface the dashboard; scheduled (background) runs stay silent
  // in the tray and report via unintrusive notifications instead.
  if (!background) {
    showDashboard();
  } else {
    notify('JobSift', 'Scheduled scrape started…', () => showDashboard());
  }
  try {
    const result = await runPipeline(options);
    // The pipeline saves an artifact even on cancel (it processes whatever was
    // collected). So if we have a result, surface it; only fall back to the
    // plain canceled view if no artifact was produced.
    if (result) {
      const aborted = scrapeAbort && scrapeAbort.signal.aborted;
      runlog.log(`Run ${aborted ? 'canceled' : 'finished'}: ${result.counts.accepted} accepted, ${result.counts.rejected} rejected; saved as ${path.basename(result.outputPath)}`);
      broadcast('scrape:complete', { ...result, canceled: !!aborted });
      if (background && !aborted) {
        const c = result.counts || {};
        notify('JobSift scrape complete',
          `${c.accepted ?? 0} accepted, ${c.rejected ?? 0} screened out. Click to view.`,
          () => showDashboard());
      }
    } else if (scrapeAbort && scrapeAbort.signal.aborted) {
      broadcast('scrape:canceled', {});
    }
  } catch (err) {
    // Not-signed-in is surfaced as a friendly prompt via 'auth:required', not a
    // hard scrape failure, so we suppress the generic error in that case.
    runlog.log(err.message === '__AUTH_REQUIRED__' ? 'Run stopped: not signed in to Jobright' : `Run failed: ${err.stack || err.message}`);
    if (scrapeAbort && scrapeAbort.signal.aborted) {
      broadcast('scrape:canceled', {});
    } else if (err.message !== '__AUTH_REQUIRED__') {
      broadcast('scrape:error', { message: err.message });
      if (background) {
        notify('JobSift scheduled run failed', err.message, () => showDashboard());
      }
    }
  } finally {
    runlog.close();
    scrapeAbort = null;
    refreshTrayMenu();
  }
}

// ── IPC registration ──────────────────────────────────────────────────────────

// Every renderer-supplied results path goes through this one gate, so load and
// delete cannot drift apart. Only .json files inside evaluatedDir() pass; the
// directory itself is refused rather than left to fail inside readFileSync.
function resolveResultPath(fpath) {
  const resolved = path.resolve(String(fpath || ''));
  const evalRoot = path.resolve(evaluatedDir());
  if (!resolved.startsWith(evalRoot + path.sep) || !resolved.toLowerCase().endsWith('.json')) {
    throw new Error('Access denied: path outside results directory');
  }
  return resolved;
}

function registerIpc() {
  // Config
  ipcMain.handle('config:load', () => cfgModule.load());
  ipcMain.handle('config:save', (_e, data) => {
    cfgModule.save(data);
    // Keep the known boards in step with the boards entered by hand.
    try { const kb = knownBoards(); kb.syncFromConfig(data); kb.save(); } catch (err) { console.error(err); }
  });
  // Read-only: the scoring rules the engine applies, shown on the config page.
  ipcMain.handle('config:rules', () => RULES);
  // The titles each run searches Jobright and Workday boards for, and where
  // Jobright is searched, with the given settings.
  ipcMain.handle('config:searchPlan', (_e, cfg) => searchPlan(cfg || {}));

  // Scrape lifecycle
  // Fire-and-forget: triggerScrape is long-running (full pipeline).
  // The renderer does NOT await the resolved value; progress arrives via events.
  // Awaiting here would hang the renderer's invoke call for the full pipeline duration.
  ipcMain.handle('scrape:start',  (_e, options) => { triggerScrape(options); });
  ipcMain.handle('scrape:cancel', () => { if (scrapeAbort) scrapeAbort.abort(); });
  // Skip the current Jobright pass (rolls over to the next), without ending the run.
  ipcMain.handle('scrape:abortPass', () => { if (passControl) passControl.abort = true; });

  // Results
  ipcMain.handle('results:getLatest', () => {
    const dir = evaluatedDir();
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
    if (!files.length) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    } catch { return null; }
  });

  ipcMain.handle('results:list', () => {
    const dir = evaluatedDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => path.join(dir, f));
  });

  ipcMain.handle('results:load', (_e, fpath) => {
    return JSON.parse(fs.readFileSync(resolveResultPath(fpath), 'utf8'));
  });

  ipcMain.handle('results:delete', (_e, fpath) => {
    fs.unlinkSync(resolveResultPath(fpath));
    return true;
  });

  // Connections. The file is chosen in the system picker, so only a file the
  // user picked is ever read; the CSV itself is not copied.
  ipcMain.handle('connections:import', async (e) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Import LinkedIn connections',
      filters: [{ name: 'LinkedIn connections (CSV)', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const file = res.filePaths[0];
    if (fs.statSync(file).size > MAX_CSV_BYTES) throw new Error('That file is too large to be a LinkedIn connections export.');
    return importConnectionsText(fs.readFileSync(file, 'utf8'));
  });
  // A file dropped on the page arrives as its text, read by the page itself,
  // so the main process never opens a path the page names.
  ipcMain.handle('connections:importText', (_e, text) => {
    if (typeof text !== 'string') throw new Error('That file could not be read.');
    if (text.length > MAX_CSV_BYTES) throw new Error('That file is too large to be a LinkedIn connections export.');
    return importConnectionsText(text);
  });
  ipcMain.handle('connections:remove', () => { connections.remove(dataDir()); return null; });
  ipcMain.handle('connections:summary', () => connectionsSummary());
  // The Connections tab's "Check them now": looks up the connections'
  // companies' job boards outside a search, the same way a search does,
  // reporting { n, total } on connections:checkProgress before each lookup
  // and the new summary on connections:updated after it.
  ipcMain.handle('connections:checkBoards', async (e) => {
    if (scrapeAbort) throw new Error('A search is running. It checks the job boards itself.');
    if (boardCheckAbort) throw new Error('The job boards are already being checked.');
    const data = connections.load(dataDir());
    if (!data) throw new Error('Import your connections first.');
    const cfg = cfgModule.load();
    const kb = knownBoards();
    kb.syncFromConfig(cfg);
    const skip = new Set([...boards.boardsFromConfig(cfg.ats_boards || {}).map(r => r.company),
                          ...Object.keys(cfg.ats_boards?.workday_companies || {})].map(connections.companyKey));
    boardCheckAbort = new AbortController();
    const signal = boardCheckAbort.signal;
    try {
      const res = await boards.checkCompanies(kb, connections.companiesByCount(data.people), {
        skip, signal, recheckDays: cfg.connections?.recheck_days || undefined,
        onProgress: (n, total) => {
          if (!e.sender.isDestroyed()) e.sender.send('connections:checkProgress', { n, total });
          if (n % 10 === 0) kb.save();   // a long check keeps what it found if the app closes
        },
        onChecked: () => broadcast('connections:updated', connectionsSummary()),
      });
      kb.save();
      return { canceled: signal.aborted, looked: res.looked, found: res.found, summary: connectionsSummary() };
    } finally {
      boardCheckAbort = null;
    }
  });
  ipcMain.handle('connections:stopCheck', () => { if (boardCheckAbort) boardCheckAbort.abort(); });
  // For the dashboard: the connections at each of the given companies, matched
  // when the dashboard is shown and never saved into results.
  ipcMain.handle('connections:forCompanies', (_e, companies) => {
    const data = connections.load(dataDir());
    if (!data || !Array.isArray(companies)) return {};
    const index = connections.peopleByKey(data.people);
    const out = {};
    for (const name of companies.slice(0, 20000)) {
      if (typeof name !== 'string') continue;
      const people = index.get(connections.companyKey(name));
      if (people) out[name] = people;
    }
    return out;
  });

  // Applied roles.
  // For the dashboard: the closest applied record for each of the given roles,
  // keyed by role id, matched when the dashboard is shown.
  ipcMain.handle('applied:forRoles', (_e, roles) => {
    if (!Array.isArray(roles)) return {};
    return applied.matchesFor(applied.load(dataDir()), roles.slice(0, 20000).map(appliedRole).filter(Boolean));
  });
  ipcMain.handle('applied:set', (_e, { role, applied: yes } = {}) => {
    const r = appliedRole(role);
    return r ? applied.setApplied(dataDir(), r, yes === true) : false;
  });

  // Company boards.
  // The known-boards entry for each of the given companies (or null), matched
  // by cleaned-up name, for the status shown beside each company.
  ipcMain.handle('boards:status', (_e, companies) => {
    const kb = knownBoards();
    const out = {};
    for (const name of (Array.isArray(companies) ? companies : []).slice(0, 5000)) {
      if (typeof name === 'string') out[name] = kb.get(name);
    }
    return out;
  });
  // Finds a company's board from its name, and an optional careers page link.
  ipcMain.handle('boards:lookup', async (_e, { company, careersUrl } = {}) => {
    company = String(company || '').trim();
    careersUrl = String(careersUrl || '').trim();
    if (!connections.companyKey(company)) throw new Error('Enter a company name.');
    if (careersUrl && !/^https?:\/\//i.test(careersUrl)) throw new Error('The careers page link must start with http:// or https://');
    const kb = knownBoards();
    let recheckDays;
    try { recheckDays = cfgModule.load().connections?.recheck_days; } catch { /* default */ }
    const result = await boards.lookup(company, kb, { careersUrl, explicit: true, recheckDays: recheckDays || undefined });
    kb.save();
    return {
      found: result.found,
      message: boards.describe(company, result),
      ats: result.found ? result.entry.ats : null,
      board: result.found ? result.entry.board : null,
    };
  });
  // Reads a board out of a pasted board link or board name.
  ipcMain.handle('boards:fromLink', (_e, { ats, link } = {}) => {
    link = String(link || '').trim();
    if (!link) throw new Error('Enter the board link.');
    if (/^https?:\/\//i.test(link)) {
      const hit = boards.boardFromUrl(link);
      if (hit) return hit;
      // A Workday careers page: its board is found by scanning it on the next run.
      if (ats === 'workday') return { ats: 'workday', careersUrl: link };
      // iCIMS and Eightfold career sites live on the company's own address.
      const origin = new URL(link).origin.toLowerCase();
      if (ats === 'icims') return { ats, board: { base_url: origin } };
      if (ats === 'eightfold') return { ats, board: { base_url: origin, domain: boards.siteDomain(new URL(origin).hostname) } };
      throw new Error(`That link is not a ${boards.SYSTEMS[ats] || 'job'} board JobSift can read.`);
    }
    if (boards.SLUG_SYSTEMS.includes(ats) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(link)) return { ats, board: { slug: link.toLowerCase() } };
    throw new Error(ats === 'workday' ? 'Paste the Workday board link or the careers page link.'
      : boards.SLUG_SYSTEMS.includes(ats) ? 'Paste the board link or its board name.'
      : `Paste a link to one of the company’s ${boards.SYSTEMS[ats] || ''} job postings.`);
  });

  // Auth
  ipcMain.handle('auth:isLoggedIn',     () => checkLoggedIn());
  ipcMain.handle('auth:openLoginWindow', () => { getLogin().show(); });

  // Scheduler
  ipcMain.handle('scheduler:get', () => {
    const cfg = cfgModule.load();
    return cfg._scheduler ?? { enabled: false, frequencyDays: 1, hour: 8, minute: 0, daysAgo: 7 };
  });
  ipcMain.handle('scheduler:set', (_e, schedule) => {
    const cfg = cfgModule.load();
    cfg._scheduler = schedule;
    cfgModule.save(cfg);
    setupScheduler(schedule);
  });

  // Run period (persisted scan window in days)
  ipcMain.handle('run:getPeriod', () => lastDaysAgo);
  ipcMain.handle('run:setPeriod', (_e, days) => {
    if (typeof days === 'number' && days > 0) {
      lastDaysAgo = days;
      try { const c = cfgModule.load(); c._lastDaysAgo = days; cfgModule.save(c); } catch { /* ignore */ }
    }
  });
}

// ── Scheduler (delegates to src/scheduler.js) ─────────────────────────────────

function setupScheduler(schedule) {
  scheduler.setup(schedule, triggerScrape);
}

// ── Crash safety ────────────────────────────────────────────────────────────────
// Surface unexpected errors instead of dying silently. A scraper throw outside
// runPipeline's try, or a rejected promise with no handler, lands here.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  const message = 'Unexpected error: ' + (err?.message || err);

  // A throw raised outside runPipeline's await chain (a timer callback, an event
  // listener) never settles triggerScrape's promise, so its finally block never
  // runs and scrapeAbort stays set. triggerScrape refuses to start while that is
  // true, so every later run is locked out until the app is restarted, and the
  // tray stays stuck on "Running...". Releasing it here trades a rare double-run
  // (only if the pipeline somehow survived) for a recoverable app.
  const wasRunning = !!scrapeAbort;
  if (wasRunning) {
    scrapeAbort = null;
    refreshTrayMenu();
  }

  try { broadcast('scrape:error', { message }); } catch { /* ignore */ }
  // A background run has no visible window, so the broadcast alone is invisible.
  if (wasRunning) notify('JobSift run stopped', message, () => showDashboard());
});
process.on('unhandledRejection', (reason) => {
  // Logged but deliberately not treated as a failed run: a rejection can come
  // from anywhere, and tearing down a healthy pipeline on one would be worse
  // than the missed report.
  console.error('Unhandled promise rejection:', reason);
});

// ── Single-instance lock ──────────────────────────────────────────────────────
// Prevent a second copy from spawning a duplicate tray and scheduler. If we are
// not the primary instance, quit immediately; the primary focuses its dashboard.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMain();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Wipe disposable browser caches left over from the previous run so the
  // userData directory stays small. We deliberately do NOT clear cookies or
  // local/indexed storage, since those hold the Jobright session.
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearCodeCaches?.({});
    await session.defaultSession.clearStorageData({
      storages: ['cachestorage', 'shadercache', 'serviceworkers'],
    });
  } catch { /* non-fatal */ }

  setupTray();
  registerIpc();

  // Restore scheduler + last-used scan period
  try {
    const cfg = cfgModule.load();
    if (cfg._scheduler?.enabled) setupScheduler(cfg._scheduler);
    if (typeof cfg._lastDaysAgo === 'number' && cfg._lastDaysAgo > 0) lastDaysAgo = cfg._lastDaysAgo;
  } catch { /* first run - no config yet */ }

  // Decide the landing window. If the user has not completed setup yet
  // (fresh config.json copied from the empty template, or setup_complete is
  // not true), present the Settings window; its UI auto-shows the setup
  // wizard whenever setup_complete !== true. Otherwise land on the dashboard.
  let configured = false;
  try { configured = cfgModule.load().setup_complete === true; } catch { configured = false; }
  if (configured) {
    showDashboard();
  } else {
    showConfig();  // config page auto-shows the setup wizard when setup_complete !== true
  }
});

// Stay in tray when all windows are closed
app.on('window-all-closed', () => { /* do not quit */ });

app.on('before-quit', () => { isQuitting = true; });
