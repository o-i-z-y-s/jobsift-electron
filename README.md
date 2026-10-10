# JobSift

JobSift is a desktop job search pipeline built with Electron. It collects roles both from Jobright.ai and directly from company ATS, scores every listing against your own criteria, and presents the results in a dashboard of accepted and rejected roles. It is a JavaScript port of an earlier Python pipeline, rebuilt as a single self-contained application.

## What it does

- Scrapes Jobright.ai using a hidden browser window that reuses your signed-in session.
- Pulls roles straight from company boards on Greenhouse, Lever, Ashby, and Workday over plain HTTP.
- Merges and de-duplicates all findings, then gives each role a match score out of 100 from four signals: how well the title matches the roles you listed, pay against your track's floor, your industries, and your skills. Scores become grades A (80+), B (65+) and C (50+); each track sets which grades it accepts, along with its work arrangements, pay floor and commute radius (geocoded via OpenStreetMap Nominatim with a local cache).
- Labels every role with its employment type (Full-time, Contract and so on, or Not stated) and who posted it (the employer, a staffing firm, or a job board), and shows the same job posted by several companies once, listing the other copies. Postings made by job boards and reposting sites are rejected by default; each track can choose which employment types it accepts.
- Shows the results in a dashboard split into accepted and rejected roles, filterable by source, track, role type, employment type and who posted it.
- Runs on demand from the tray or the dashboard, or on a regular schedule.

## Requirements

To run a release:
- Windows (primary target; macOS build config is included).

To build:
- Node.js and npm, only to install the pinned dependencies and to run or package the app.

## Getting started

On first launch the setup wizard appears. It walks you through the roles you want (Ideal, Good or Acceptable), your first track, industries and skills, where to search, and what to avoid, then drops you on the dashboard. You can reopen it any time from the Configure button on the dashboard or the Settings item in the tray.

Your settings are stored per user at `%APPDATA%/JobSift/config.json` (created from the blank template in `resources/config.json` on first run). The repo copy stays empty, so your personal config is never committed. A config from an earlier version is moved to the current layout the first time it loads; the original is kept beside it as `config.before-v<N>.json` (N being the new layout version), and the config page lists anything that could not be carried over.

## Using

- Pick a scan period (past 24 hours, 3 days, week, or month) and press Run Now, from either the dashboard or the tray.
- Sign in to Jobright within the interface; the app detects your session automatically and continues.
- Past runs can be reopened from the Load Past Result picker.

## Building

```bash
npm run dist:win   # Windows NSIS installer
npm run dist:mac   # macOS dmg
```

Build configuration lives in `electron-builder.yml`. Application icons are in `assets/`; the runtime tray icon is `resources/icon.png`.

## Project layout

```
jobsift-electron/
├── src/
│   ├── main.js              App entry: tray, windows, IPC, pipeline, scheduler
│   ├── config.js            Per-user config read/write
│   ├── scheduler.js         Daily scheduler
│   ├── eval.js              Evaluation engine: filters, tracks, grades
│   ├── criteria.js          Match score, grades and config migration
│   ├── sources.js           Employment type, who posted a job, duplicate postings
│   └── scraper/
│       ├── jobright.js      Jobright scraper (hidden BrowserWindow)
│       └── ats-http.js      Greenhouse/Lever/Ashby/Workday scraper
├── ui/
│   ├── preload.js           contextBridge API surface
│   ├── dashboard/index.html Results dashboard
│   ├── config/index.html    Settings + setup wizard
│   └── shared/              Palette (tokens.css) and HTML escaping helpers (dom.js)
├── resources/               Blank config template + tray icon (bundled)
├── assets/                  Packaged app/installer icons
└── electron-builder.yml     Build/publish configuration
```

## Development constraints 

Out of an abundance of caution regarding the absolute state of npm right now... The full dependency tree used in development was scrutinized at length and dependencies are version-locked with integrity hashes.

- No new npm packages without an explicit, full supply-chain audit. The `overrides` block in `package.json` is audited and must not be changed.
- No TypeScript, no bundler, no build step: `electron .` must run with zero compilation.
- Plain JavaScript only.
- `node_modules` and build output are git-ignored and must never be committed.
