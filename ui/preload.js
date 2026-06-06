'use strict';

/**
 * ui/preload.js
 * Runs in the renderer context with Node integration disabled.
 * Exposes window.electronAPI via contextBridge — the full surface from HANDOFF §10.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Config ──────────────────────────────────────────────────────────────────
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // ── Scrape lifecycle ────────────────────────────────────────────────────────
  startScrape:  (options) => ipcRenderer.invoke('scrape:start', options),
  cancelScrape: ()        => ipcRenderer.invoke('scrape:cancel'),
  abortPass:    ()        => ipcRenderer.invoke('scrape:abortPass'),

  onScrapeProgress: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('scrape:progress', handler);
    return () => ipcRenderer.removeListener('scrape:progress', handler);
  },
  onScrapeComplete: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('scrape:complete', handler);
    return () => ipcRenderer.removeListener('scrape:complete', handler);
  },
  onScrapeError: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('scrape:error', handler);
    return () => ipcRenderer.removeListener('scrape:error', handler);
  },
  onScrapeCancelled: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('scrape:cancelled', handler);
    return () => ipcRenderer.removeListener('scrape:cancelled', handler);
  },

  // ── Results ─────────────────────────────────────────────────────────────────
  getLatestResult: ()       => ipcRenderer.invoke('results:getLatest'),
  listResults:     ()       => ipcRenderer.invoke('results:list'),
  loadResult:      (fpath)  => ipcRenderer.invoke('results:load', fpath),
  deleteResult:    (fpath)  => ipcRenderer.invoke('results:delete', fpath),

  // ── Auth ────────────────────────────────────────────────────────────────────
  isLoggedIn:      ()  => ipcRenderer.invoke('auth:isLoggedIn'),
  openLoginWindow: ()  => ipcRenderer.invoke('auth:openLoginWindow'),

  onLoginComplete: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('auth:loginComplete', handler);
    return () => ipcRenderer.removeListener('auth:loginComplete', handler);
  },

  onAuthRequired: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('auth:required', handler);
    return () => ipcRenderer.removeListener('auth:required', handler);
  },

  // ── Scheduler ───────────────────────────────────────────────────────────────
  getSchedule: ()         => ipcRenderer.invoke('scheduler:get'),
  setSchedule: (schedule) => ipcRenderer.invoke('scheduler:set', schedule),

  // ── Window navigation ─────────────────────────────────────────────────────
  openConfigWindow: () => ipcRenderer.invoke('config:openWindow'),
  openDashboard:    () => ipcRenderer.invoke('dashboard:open'),

  // ── Run period (persisted) ──────────────────────────────────────────────────
  getRunPeriod: ()      => ipcRenderer.invoke('run:getPeriod'),
  setRunPeriod: (days)  => ipcRenderer.invoke('run:setPeriod', days),

  // ── App ─────────────────────────────────────────────────────────────────────
  getVersion:      () => ipcRenderer.sendSync('app:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
});
