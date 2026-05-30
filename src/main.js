'use strict';

/**
 * src/main.js
 * App entry point. Manages tray, windows, IPC, pipeline orchestration,
 * and the setTimeout-based scheduler.
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, net,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');

const cfgModule  = require('./config');
const scheduler  = require('./scheduler');

// ── Directory helpers ─────────────────────────────────────────────────────────

function evaluatedDir() {
  return path.join(app.getPath('userData'), 'Scrapes', 'Evaluated Scrapes');
}
function stagingDir() {
  return path.join(app.getPath('userData'), 'Scrapes', 'Raw Scrape Staging');
}
function rawDir() {
  return path.join(app.getPath('userData'), 'Scrapes', 'Raw');
}

function timestamp() {
  // Format: YYYY-MM-DD_HH-MM  (matches Python pipeline convention)
  const now = new Date();
  const d = now.toISOString();
  return d.slice(0, 10) + '_' + d.slice(11, 16).replace(':', '-');
}

const SCAN_LABELS = { 1: 'Past 24 hours', 3: 'Past 3 days', 7: 'Past week', 30: 'Past 30 days' };

// ── App state ─────────────────────────────────────────────────────────────────

let tray         = null;
let loginWin     = null;
let configWin    = null;
let dashboardWin = null;
let scrapeAbort  = null;   // AbortController | null
let isQuitting   = false;

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
    dashboardWin = makeWin({ width: 1280, height: 900, title: 'Jobsift' });
    dashboardWin.loadFile(path.join(__dirname, '..', 'ui', 'dashboard', 'index.html'));
  }
  return dashboardWin;
}

function getConfig() {
  if (!configWin || configWin.isDestroyed()) {
    configWin = makeWin({ width: 960, height: 720, title: 'Jobsift - Settings' });
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

    // Auto-hide once sign-in completes (URL leaves the /login path)
    loginWin.webContents.on('did-navigate', (_e, url) => {
      if (url.includes('jobright.ai') && !url.toLowerCase().includes('login')) {
        setTimeout(() => {
          if (loginWin && !loginWin.isDestroyed()) loginWin.hide();
        }, 1200);
      }
    });
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
                       : () => triggerScrape({ daysAgo: 7 }),
    },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => { getDashboard().show(); } },
    { label: 'Settings',       click: () => { getConfig().show();    } },
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

async function checkLoggedIn() {
  try {
    // net.fetch uses the default session (with Jobright cookies) in the main process.
    // HEAD is unreliable on SPA CDN frontends - use GET, cap response body at start.
    // Follow redirects and check the final URL; a 'login' path means session expired.
    const r = await net.fetch('https://jobright.ai/', {
      method: 'GET',
      headers: { 'Accept': 'text/html' },
    });
    return !r.url.toLowerCase().includes('login');
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
  const { daysAgo = 7 } = options || {};
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
    throw new Error('Not signed in to Jobright.ai - please log in first.');
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

  // Collect ATS URLs seen in ALL prior evaluated outputs so they are skipped
  const priorUrls = new Set();
  const evalDir = evaluatedDir();
  if (fs.existsSync(evalDir)) {
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
  scrapeAbort = new AbortController();
  refreshTrayMenu();
  getDashboard().show();
  try {
    const result = await runPipeline(options);
    if (result && !scrapeAbort.signal.aborted) {
      broadcast('scrape:complete', result);
    }
  } catch (err) {
    broadcast('scrape:error', { message: err.message });
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
  ipcMain.handle('scrape:start',  (_e, options) => triggerScrape(options));
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

  // App
  ipcMain.on('app:getVersion', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.handle('app:checkForUpdates', () => autoUpdater.checkForUpdatesAndNotify());
}

// ── Scheduler (delegates to src/scheduler.js) ─────────────────────────────────

function setupScheduler(schedule) {
  scheduler.setup(schedule, triggerScrape);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  setupTray();
  registerIpc();

  // Restore scheduler
  try {
    const cfg = cfgModule.load();
    if (cfg._scheduler?.enabled) setupScheduler(cfg._scheduler);
  } catch { /* first run - no config yet */ }

  // Show login or dashboard on startup
  const loggedIn = await checkLoggedIn();
  if (loggedIn) {
    getDashboard().show();
  } else {
    getLogin().show();
  }
});

// Stay in tray when all windows are closed
app.on('window-all-closed', () => { /* do not quit */ });

app.on('before-quit', () => { isQuitting = true; });
