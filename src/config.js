'use strict';

/**
 * src/config.js
 * Manages the per-user config.json in Electron userData.
 *
 * resources/config.json is the canonical EMPTY template that ships with the
 * repo. It holds the full config structure with blank values and is the single
 * source of truth for "what a fresh config looks like". On first run (or for a
 * new user) it is copied verbatim into userData/config.json, which is where all
 * user edits live. The repo copy is never modified, so a modified config.json
 * is never committed.
 */

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'resources', 'config.json');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  const dest = configPath();
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(TEMPLATE_PATH, dest);
  }
  return JSON.parse(fs.readFileSync(dest, 'utf8'));
}

function save(config) {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

module.exports = { load, save, configPath };
