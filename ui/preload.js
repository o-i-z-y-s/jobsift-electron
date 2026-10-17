'use strict';

/**
 * ui/preload.js
 * Runs in the renderer context with Node integration disabled.
 * Exposes window.electronAPI via contextBridge. This is the ONLY channel between
 * the renderer and the main process; every entry here has a matching
 * ipcMain handler in src/main.js.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Config ──────────────────────────────────────────────────────────────────
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  getScoringRules: () => ipcRenderer.invoke('config:rules'),
  getJobrightPlan: (config) => ipcRenderer.invoke('config:jobrightPlan', config),

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
  onScrapeCanceled: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('scrape:canceled', handler);
    return () => ipcRenderer.removeListener('scrape:canceled', handler);
  },

  // ── Results ─────────────────────────────────────────────────────────────────
  getLatestResult: ()       => ipcRenderer.invoke('results:getLatest'),
  listResults:     ()       => ipcRenderer.invoke('results:list'),
  loadResult:      (fpath)  => ipcRenderer.invoke('results:load', fpath),
  deleteResult:    (fpath)  => ipcRenderer.invoke('results:delete', fpath),

  // ── Connections ─────────────────────────────────────────────────────────────
  importConnections:      ()          => ipcRenderer.invoke('connections:import'),
  importConnectionsText:  (text)      => ipcRenderer.invoke('connections:importText', text),
  removeConnections:      ()          => ipcRenderer.invoke('connections:remove'),
  getConnectionsSummary:  ()          => ipcRenderer.invoke('connections:summary'),
  connectionsForCompanies: (companies) => ipcRenderer.invoke('connections:forCompanies', companies),
  checkConnectionBoards:  ()          => ipcRenderer.invoke('connections:checkBoards'),
  stopConnectionBoardsCheck: ()       => ipcRenderer.invoke('connections:stopCheck'),
  onConnectionBoardsProgress: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('connections:checkProgress', handler);
    return () => ipcRenderer.removeListener('connections:checkProgress', handler);
  },
  // The connections summary again after each company is looked up, by a check
  // or a search.
  onConnectionsUpdated: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('connections:updated', handler);
    return () => ipcRenderer.removeListener('connections:updated', handler);
  },

  // ── Company boards ──────────────────────────────────────────────────────────
  boardStatus:     (companies)              => ipcRenderer.invoke('boards:status', companies),
  lookupBoard:     (company, careersUrl)    => ipcRenderer.invoke('boards:lookup', { company, careersUrl }),
  boardFromLink:   (ats, link)              => ipcRenderer.invoke('boards:fromLink', { ats, link }),

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

  // ── Run period (persisted) ──────────────────────────────────────────────────
  getRunPeriod: ()      => ipcRenderer.invoke('run:getPeriod'),
  setRunPeriod: (days)  => ipcRenderer.invoke('run:setPeriod', days),
});
