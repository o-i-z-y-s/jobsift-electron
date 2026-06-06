'use strict';

/**
 * src/main.js
 * App entry point. Manages tray, windows, IPC, pipeline orchestration,
 * and the setTimeout-based scheduler.
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, net, session, Notification, shell,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');

const cfgModule  = require('./config');
const scheduler  = require('./scheduler');

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
// Single intermediate folder for both the raw per-source dumps and the transient
// merged file (the merge file is deleted on a successful run). Consolidated from
// the former separate "Raw" and "Raw Scrape Staging" folders.
function stagingDir() {
  return path.join(app.getPath('userData'), 'Scrapes', 'Raw Scrape Staging');
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

const SCAN_LABELS = { 1: 'Past 24 hours', 3: 'Past 3 days', 7: 'Past week', 30: 'Past 30 days' };

// ── Requisition-id dedup (all platforms, both sources) ────────────────────────
// The same job is often listed many times (e.g. once per authorized state) with
// distinct jids and apply URLs but one underlying requisition. atsUrlKey turns a
// supported ATS apply URL into a canonical "platform:id" key. Because Jobright's
// "Original Job Post" link and the direct ATS fetch point at the SAME posting,
// both yield the same key, so duplicates collapse across both sources and across
// Greenhouse, Lever, Ashby, and Workday.
function atsUrlKey(url) {
  if (!url) return '';
  let u;
  try { u = new URL(url); } catch { return ''; }
  const host = u.host.toLowerCase();
  const path = u.pathname || '';
  const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  let m;
  if (host.includes('greenhouse.io')) {            // boards.greenhouse.io/{board}/jobs/{numericId}
    m = path.match(/\/jobs\/(\d+)/);
    if (m) return `gh:${m[1]}`;
  }
  if (host.includes('lever.co')) {                 // jobs.lever.co/{slug}/{uuid}
    m = path.match(UUID);
    if (m) return `lv:${m[1].toLowerCase()}`;
  }
  if (host.includes('ashbyhq.com')) {              // jobs.ashbyhq.com/{slug}/{uuid}
    m = path.match(UUID);
    if (m) return `as:${m[1].toLowerCase()}`;
  }
  if (host.includes('myworkdayjobs.com')) {        // .../...{title}_{reqId}  (one per state)
    m = path.match(/_([A-Za-z]{1,5}-?\d{4,})(?:[-_]\d{1,3})?$/)
     || path.match(/([A-Za-z]{1,5}-?\d{4,})(?:[-_]\d{1,3})?(?:[/?#]|$)/);
    if (m) return `wd:${host}:${m[1].toUpperCase()}`;
  }
  // Career-network sites (e.g. "{company}.jobs") that list the same role once per
  // location as /{location}/{title-slug}/{32-hex-id}/job/. The location and hex id
  // differ per posting, so key on host + the stable title slug.
  m = path.match(/\/([^/]+)\/[0-9a-f]{32}\/job\/?$/i);
  if (m) return `slug:${host}:${m[1].toLowerCase()}`;
  return '';
}

function reqKeyOf(role) {
  const k = atsUrlKey(role.ats_url || role.apply_url || '');
  if (k) return k;
  // Fallback: a labeled "Reqid:" in the role text (company-scoped).
  const text = `${role.body_text || ''} ${role.card_text || ''} ${role.required_quals || ''}`;
  const tm = text.match(/\bReq(?:uisition)?\s*(?:id|#|no\.?)?\s*[:#]\s*([A-Za-z]{1,6}-?\d{3,})/i);
  if (tm) return `txt:${(role.company || '').toLowerCase()}|${tm[1].toUpperCase()}`;
  return '';
}

// ── App state ─────────────────────────────────────────────────────────────────

let tray         = null;
let loginWin     = null;
let mainWin      = null;   // single app window (dashboard + config + wizard)
let scrapeAbort  = null;   // AbortController | null
let isQuitting   = false;
let lastDaysAgo  = 7;      // last-used scan period (days); persisted in config._lastDaysAgo
let passControl  = null;   // { abort: bool } - lets the user skip the current Jobright pass

// ── Preload path ──────────────────────────────────────────────────────────────

const PRELOAD = path.join(__dirname, '..', 'ui', 'preload.js');

// ── Window factory ────────────────────────────────────────────────────────────

function makeWin(opts = {}) {
  const win = new BrowserWindow({
    show: false,
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
        const newSession = cs.some(c =>
          !_baseline.has(c.name) &&
          !ANALYTICS_COOKIE_RE.test(c.name) &&
          (c.httpOnly === true || AUTH_COOKIE_RE.test(c.name)));
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
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
    // Hovering the tray icon reflects whether a scrape (manual or scheduled) is running.
    tray.setToolTip(scrapeAbort ? 'JobSift — scraping in progress…' : 'JobSift');
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

async function checkLoggedIn() {
  // Check for persisted Jobright session cookies in the default session.
  // Reliable across restarts (Electron stores cookies on disk in userData) and
  // avoids the SPA redirect problem that makes net.fetch unreliable.
  //
  // We treat the user as signed in only if there is a non-expired cookie whose
  // NAME looks like a session/auth token, ignoring known analytics cookies.
  // We intentionally do NOT count "httpOnly" as a signal here: jobright.ai sets
  // httpOnly cookies on the anonymous page before sign-in, so that would produce
  // a false positive that hides the login window and the Sign In button.
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: 'jobright.ai' });
    const now = Date.now() / 1000;
    return cookies.some(c => {
      const live = !c.expirationDate || c.expirationDate > now;
      if (!live) return false;
      if (ANALYTICS_COOKIE_RE.test(c.name)) return false;
      return AUTH_COOKIE_RE.test(c.name);
    });
  } catch {
    return false;
  }
}

// ── Progress broadcast ────────────────────────────────────────────────────────

function broadcast(channel, payload) {
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

  // Lazy requires - scrapers/eval are written later; prevents startup failure
  // if those files don't exist yet during development.
  const jobrightScraper = require('./scraper/jobright');
  const atsScraper      = require('./scraper/ats-http');
  const evalEngine      = require('./eval');

  const cfg = cfgModule.load();

  for (const d of [evaluatedDir(), stagingDir(), rawDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }

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
  let jobrightRaw = [];
  passControl = { abort: false };  // reset; the Abort Pass button flips abort=true
  try {
    jobrightRaw = await jobrightScraper.run({
      cfg,
      daysAgo,
      signal: scrapeAbort.signal,
      passControl,
      onProgress: (msg, pct) =>
        broadcast('scrape:progress', {
          step: 'jobright',
          message: msg,
          pct: 5 + Math.round(pct * 0.50),
        }),
    });
  } catch (err) {
    console.error('Jobright scraper failed:', err);
    broadcast('scrape:progress', {
      step: 'jobright',
      message: `Jobright step failed (${err.message}); continuing with ATS results`,
      pct: 55,
    });
  }

  fs.writeFileSync(
    path.join(rawDir(), `job-search-jobright-${ts}.json`),
    JSON.stringify(jobrightRaw, null, 2), 'utf8',
  );
  broadcast('scrape:progress', {
    step: 'jobright',
    message: `Jobright: ${jobrightRaw.length} listings collected`,
    pct: 55,
  });

  // ── ATS HTTP (13% of progress budget) ─────────────────────────────────────
  broadcast('scrape:progress', { step: 'ats', message: 'Scraping ATS boards...', pct: 57 });

  let atsRaw = [];
  try {
    atsRaw = await atsScraper.run({
      cfg,
      signal: scrapeAbort.signal,
      onProgress: (msg, pct) =>
        broadcast('scrape:progress', {
          step: 'ats',
          message: msg,
          pct: 57 + Math.round(pct * 0.13),
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

  fs.writeFileSync(
    path.join(rawDir(), `job-search-ats-http-${ts}.json`),
    JSON.stringify(atsRaw, null, 2), 'utf8',
  );
  broadcast('scrape:progress', {
    step: 'ats',
    message: `ATS: ${atsRaw.length} listings collected`,
    pct: 70,
  });

  // ── Merge + dedup ──────────────────────────────────────────────────────────
  broadcast('scrape:progress', { step: 'merge', message: 'Merging results...', pct: 72 });

  // Collect ATS URLs seen in ALL prior evaluated outputs so they are skipped.
  // Skipped entirely when includeSeen is set, so a run shows its full set.
  const priorUrls = new Set();
  const priorReq  = new Set();
  const evalDir = evaluatedDir();
  if (!includeSeen && fs.existsSync(evalDir)) {
    for (const f of fs.readdirSync(evalDir).filter(n => n.endsWith('.json'))) {
      try {
        const prior = JSON.parse(fs.readFileSync(path.join(evalDir, f), 'utf8'));
        for (const section of ['accepted', 'rejected']) {
          for (const role of (prior[section]?.roles || [])) {
            const u = (role.apply_url || role.ats_url || '').toLowerCase().replace(/\/$/, '');
            if (u) priorUrls.add(u);
            const rk = reqKeyOf(role);
            if (rk) priorReq.add(rk);
          }
        }
      } catch { /* skip malformed files */ }
    }
  }

  const seenJids = new Set();
  const seenUrls = new Set();
  const seenReq  = new Set();
  const merged   = [];

  for (const r of [...jobrightRaw, ...atsRaw]) {
    if (seenJids.has(r.jid)) continue;
    seenJids.add(r.jid);
    // Same requisition listed across states (same Reqid, different jid/URL)
    // collapses here.
    const rk = reqKeyOf(r);
    if (rk && (seenReq.has(rk) || priorReq.has(rk))) continue;
    const uk = (r.ats_url || '').toLowerCase().replace(/\/$/, '');
    if (uk && (seenUrls.has(uk) || priorUrls.has(uk))) continue;
    if (rk) seenReq.add(rk);
    if (uk) seenUrls.add(uk);
    merged.push(r);
  }

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

// ── Trigger scrape (used by tray and IPC handler) ─────────────────────────────

async function triggerScrape(options) {
  if (scrapeAbort) return;  // already running
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
    // The pipeline always saves an artifact now, even on cancel (it processes
    // whatever was collected). So if we have a result, surface it; only fall back
    // to the plain cancelled view if no artifact was produced.
    if (result) {
      const aborted = scrapeAbort && scrapeAbort.signal.aborted;
      broadcast('scrape:complete', { ...result, cancelled: !!aborted });
      if (background && !aborted) {
        const c = result.counts || {};
        notify('JobSift scrape complete',
          `${c.accepted ?? 0} accepted, ${c.rejected ?? 0} screened out. Click to view.`,
          () => showDashboard());
      }
    } else if (scrapeAbort && scrapeAbort.signal.aborted) {
      broadcast('scrape:cancelled', {});
    }
  } catch (err) {
    // Not-signed-in is surfaced as a friendly prompt via 'auth:required', not a
    // hard scrape failure, so we suppress the generic error in that case.
    if (scrapeAbort && scrapeAbort.signal.aborted) {
      broadcast('scrape:cancelled', {});
    } else if (err.message !== '__AUTH_REQUIRED__') {
      broadcast('scrape:error', { message: err.message });
      if (background) {
        notify('JobSift scheduled run failed', err.message, () => showDashboard());
      }
    }
  } finally {
    scrapeAbort = null;
    refreshTrayMenu();
  }
}

// ── IPC registration ──────────────────────────────────────────────────────────

function registerIpc() {
  // Config
  ipcMain.handle('config:load', () => cfgModule.load());
  ipcMain.handle('config:save', (_e, data) => cfgModule.save(data));

  // Scrape lifecycle
  // Fire-and-forget: triggerScrape is long-running (full pipeline).
  // The renderer does NOT await the resolved value — progress arrives via events.
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
    // Validate that the requested path is inside evaluatedDir() — no traversal
    const resolved  = path.resolve(fpath);
    const evalRoot  = path.resolve(evaluatedDir());
    if (!resolved.startsWith(evalRoot + path.sep) && resolved !== evalRoot) {
      throw new Error('Access denied: path outside results directory');
    }
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  });

  ipcMain.handle('results:delete', (_e, fpath) => {
    // Same path-safety check as load: only files inside the results directory,
    // and only .json scrape outputs, may be deleted.
    const resolved = path.resolve(fpath);
    const evalRoot = path.resolve(evaluatedDir());
    if (!resolved.startsWith(evalRoot + path.sep) || !resolved.toLowerCase().endsWith('.json')) {
      throw new Error('Access denied: path outside results directory');
    }
    fs.unlinkSync(resolved);
    return true;
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

  // Window navigation
  ipcMain.handle('config:openWindow', () => { showConfig(); });
  ipcMain.handle('dashboard:open',    () => { showDashboard(); });

  // Run period (persisted scan window in days)
  ipcMain.handle('run:getPeriod', () => lastDaysAgo);
  ipcMain.handle('run:setPeriod', (_e, days) => {
    if (typeof days === 'number' && days > 0) {
      lastDaysAgo = days;
      try { const c = cfgModule.load(); c._lastDaysAgo = days; cfgModule.save(c); } catch { /* ignore */ }
    }
  });

  // App
  ipcMain.on('app:getVersion', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.handle('app:checkForUpdates', () => autoUpdater.checkForUpdatesAndNotify());
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
  try { broadcast('scrape:error', { message: 'Unexpected error: ' + (err?.message || err) }); } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
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
  // not true), present the Settings window — its UI auto-shows the setup
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
