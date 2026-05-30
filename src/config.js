'use strict';

/**
 * src/config.js
 * Manages config.json in Electron userData.
 * Copies the clean template on first run if no config exists yet.
 */

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'resources', 'config_clean.json');

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
