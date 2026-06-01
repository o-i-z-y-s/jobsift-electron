'use strict';

/**
 * src/main.js
 * App entry point. Manages tray, windows, IPC, pipeline orchestration,
 * and the setTimeout-based scheduler.
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, net, session,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');

const cfgModule  = require('./config');
const scheduler  = require('./scheduler');

// Force the app name so the userData directory is ALWAYS %APPDATA%/Jobsift,
// regardless of how the app is launched. When launched as `electron .` the name
// comes from package.json (Jobsift), but launching the script directly (e.g. some
// VS Code debug configs) or other entry points can fall back to "Electron",
// which would point at a different userData folder with no config. Setting it
// explicitly here (before 'ready') keeps config and data in one place.
app.setName('Jobsift');

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

// ── App state ─────────────────────────────────────────────────────────────────

let tray         = null;
let loginWin     = null;
let configWin    = null;
let dashboardWin = null;
let scrapeAbort  = null;   // AbortController | null
let isQuitting   = false;
let lastDaysAgo  = 7;      // last-used scan period (days); persisted in config._lastDaysAgo

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
  return win;
}

// ── Named window accessors ────────────────────────────────────────────────────

function getDashboard() {
  if (!dashboardWin || dashboardWin.isDestroyed()) {
    dashboardWin = makeWin({ width: 1600, height: 900, minWidth: 1100, minHeight: 700, title: 'Jobsift' });
    dashboardWin.loadFile(path.join(__dirname, '..', 'ui', 'dashboard', 'index.html'));
  }
  return dashboardWin;
}

function getConfig() {
  if (!configWin || configWin.isDestroyed()) {
    configWin = makeWin({ width: 1600, height: 900, minWidth: 1100, minHeight: 700, title: 'Jobsift - Settings' });
    configWin.loadFile(path.join(__dirname, '..', 'ui', 'config', 'index.html'));
  }
  return configWin;
}

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
          getDashboard().show();
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
  tray.setToolTip('Jobsift');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => { getDashboard().show(); });
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
    { label: 'Open Dashboard', click: () => { getDashboard().show(); } },
    { label: 'Settings',       click: () => { getConfig().show();    } },
    { label: 'Sign In',        click: () => { getLogin().show();     } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
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
  for (const win of [dashboardWin, configWin]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

async function runPipeline(options) {
  const { daysAgo = 7, includeSeen = false } = options || {};
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
    getLogin().show();
    broadcast('auth:required', {});
    throw new Error('__AUTH_REQUIRED__');  // sentinel: handled as a prompt, not an error
  }

  // ── Jobright (50% of progress budget) ─────────────────────────────────────
  broadcast('scrape:progress', { step: 'jobright', message: 'Launching Jobright scraper...', pct: 5 });

  const jobrightRaw = await jobrightScraper.run({
    cfg,
    daysAgo,
    signal: scrapeAbort.signal,
    onProgress: (msg, pct) =>
      broadcast('scrape:progress', {
        step: 'jobright',
        message: msg,
        pct: 5 + Math.round(pct * 0.50),
      }),
  });

  if (scrapeAbort.signal.aborted) return null;

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

  const atsRaw = await atsScraper.run({
    cfg,
    signal: scrapeAbort.signal,
    onProgress: (msg, pct) =>
      broadcast('scrape:progress', {
        step: 'ats',
        message: msg,
        pct: 57 + Math.round(pct * 0.13),
      }),
  });

  if (scrapeAbort.signal.aborted) return null;

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
  const evalDir = evaluatedDir();
  if (!includeSeen && fs.existsSync(evalDir)) {
    for (const f of fs.readdirSync(evalDir).filter(n => n.endsWith('.json'))) {
      try {
        const prior = JSON.parse(fs.readFileSync(path.join(evalDir, f), 'utf8'));
        for (const section of ['accepted', 'rejected']) {
          for (const role of (prior[section]?.roles || [])) {
            const u = (role.apply_url || role.ats_url || '').toLowerCase().replace(/\/$/, '');
            if (u) priorUrls.add(u);
          }
        }
      } catch { /* skip malformed files */ }
    }
  }

  const seenJids = new Set();
  const seenUrls = new Set();
  const merged   = [];

  for (const r of [...jobrightRaw, ...atsRaw]) {
    if (seenJids.has(r.jid)) continue;
    seenJids.add(r.jid);
    const uk = (r.ats_url || '').toLowerCase().replace(/\/$/, '');
    if (uk && (seenUrls.has(uk) || priorUrls.has(uk))) continue;
    if (uk) seenUrls.add(uk);
    merged.push(r);
  }

  const mergePayload = {
    scraped_at: new Date().toISOString(),
    date:       ts.slice(0, 10),
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

  if (scrapeAbort.signal.aborted) return null;

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
  scrapeAbort = new AbortController();
  refreshTrayMenu();
  getDashboard().show();
  try {
    const result = await runPipeline(options);
    if (scrapeAbort && scrapeAbort.signal.aborted) {
      // Cancelled: tell the UI so it can leave the progress view, rather than
      // hanging on the last progress message.
      broadcast('scrape:cancelled', {});
    } else if (result) {
      broadcast('scrape:complete', result);
    }
  } catch (err) {
    // Not-signed-in is surfaced as a friendly prompt via 'auth:required', not a
    // hard scrape failure, so we suppress the generic error in that case.
    if (scrapeAbort && scrapeAbort.signal.aborted) {
      broadcast('scrape:cancelled', {});
    } else if (err.message !== '__AUTH_REQUIRED__') {
      broadcast('scrape:error', { message: err.message });
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

  // Auth
  ipcMain.handle('auth:isLoggedIn',     () => checkLoggedIn());
  ipcMain.handle('auth:openLoginWindow', () => { getLogin().show(); });

  // Scheduler
  ipcMain.handle('scheduler:get', () => {
    const cfg = cfgModule.load();
    return cfg._scheduler ?? { enabled: false, cronHour: 8, cronMinute: 0 };
  });
  ipcMain.handle('scheduler:set', (_e, schedule) => {
    const cfg = cfgModule.load();
    cfg._scheduler = schedule;
    cfgModule.save(cfg);
    setupScheduler(schedule);
  });

  // Window navigation
  ipcMain.handle('config:openWindow', () => { getConfig().show(); });
  ipcMain.handle('dashboard:open',    () => { getDashboard().show(); });

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
    const win = getDashboard();
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
    getDashboard().show();
  } else {
    getConfig().show();
  }
});

// Stay in tray when all windows are closed
app.on('window-all-closed', () => { /* do not quit */ });

app.on('before-quit', () => { isQuitting = true; });
