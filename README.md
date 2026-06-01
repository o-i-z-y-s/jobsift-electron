# JobSift

JobSift is a desktop job-search pipeline built with Electron. It collects roles from Jobright.ai and directly from company applicant tracking systems (ATS), scores every listing against your own criteria, and presents the results in a dashboard of accepted and rejected roles. It is a JavaScript port of an earlier Python pipeline, rebuilt as a single self-contained app with no external services.

## What it does

- Scrapes Jobright.ai using a hidden browser window that reuses your signed-in session.
- Pulls roles straight from company boards on Greenhouse, Lever, Ashby, and Workday over plain HTTP.
- Merges and de-duplicates everything, then runs a scoring engine that grades each role (A/B/C) using your tracks, salary floors, work-arrangement rules, domain scoring, and commute radius (geocoded via OpenStreetMap Nominatim with a local cache).
- Shows the results in a dashboard split into accepted and rejected roles, with source, track, and type filters.
- Runs on demand from the tray or the dashboard, or on a daily schedule.

## Requirements

- Windows (primary target; macOS build config is included).
- Node.js and npm, only to install the pinned dependencies and to run or package the app.

## Getting started

```bash
npm install
npm start
```

On first launch the setup wizard appears. It walks you through your job titles, salary floor, work arrangement, locations, domain keywords, block lists, and ATS boards, then drops you on the dashboard. You can reopen it any time from the Configure button on the dashboard or the Settings item in the tray.

Your settings are stored per user at `%APPDATA%/JobSift/config.json` (created from the blank template in `resources/config.json` on first run). The repo copy stays empty, so your personal config is never committed.

## Using it

- Pick a scan period (past 24 hours, 3 days, week, or month) and press Run Now, from either the dashboard or the tray.
- Sign in to Jobright when prompted; the app detects your session automatically and continues.
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
│   ├── eval.js              Scoring engine
│   └── scraper/
│       ├── jobright.js      Jobright scraper (hidden BrowserWindow)
│       └── ats-http.js      Greenhouse/Lever/Ashby/Workday scraper
├── ui/
│   ├── preload.js           contextBridge API surface
│   ├── dashboard/index.html Results dashboard
│   ├── config/index.html    Settings + setup wizard
│   └── login/index.html     Sign-in shell
├── resources/               Blank config template + tray icon (bundled)
├── assets/                  Packaged app/installer icons
└── electron-builder.yml     Build/publish configuration
```

## Development constraints

- No new npm packages without an explicit, full supply-chain audit. The `overrides` block in `package.json` is audited and must not be changed.
- No TypeScript, no bundler, no build step: `electron .` must run with zero compilation.
- Plain JavaScript only.
- `node_modules` and build output are git-ignored and must never be committed.

## License

MIT
