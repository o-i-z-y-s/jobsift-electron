# JobSift

JobSift is a desktop job search pipeline built with Electron. It collects roles both from Jobright.ai and directly from company ATS, scores every listing against your own criteria, and presents the results in a dashboard of accepted and rejected roles. It is a JavaScript port of an earlier Python pipeline, rebuilt as a single self-contained application.

## What it does

- Scrapes Jobright.ai using a hidden browser window that reuses your signed-in session. It searches once for each title listed under Jobright on the Sources tab, for the arrangements your tracks accept: remote roles from anywhere in the country, and onsite or hybrid roles near the locations set on your tracks. Jobright itself leaves out what every track rejects anyway: employment types no track accepts, roles needing a security clearance when every track rejects them, companies in your blocked industries, and experience levels turned off on the Sources tab. Everything is set in JobSift; nothing needs setting on Jobright beyond your account and resume. Each card is judged on what it shows (title, company, industry tags, place, arrangement, employment type, pay, and who posted it) before its posting is opened: a card every track rejects is listed as rejected without being opened, and a posting that a run of the last 30 days read, found closed, or already showed you is not opened again. The hidden window loads no pictures, fonts, or third-party tracking scripts, since only the pages' text is read. At most two postings are opened at a time, with a pause between them, and the pause grows while postings fail to load. If Jobright refuses a page, answers "too many requests", or your session ends, the run asks it for nothing more, and after a refusal Jobright is left alone for 30 minutes. A scheduled run searches Jobright only as far back as the last completed run, as long as your settings have not changed since.
- Pulls roles straight from company boards on Greenhouse, Lever, Ashby, Workday, Eightfold, Oracle, Gem, iCIMS career sites, Rippling, and Workable over plain HTTP; Workday, Eightfold, and Oracle boards are searched for the roles you mark for searching on the Roles tab, using the fewest titles that cover them (shown under your roles). Several boards are read at once, but never two searches at once on the same site, and a site that asks JobSift to slow down is waited on without holding up the rest. Eightfold boards are searched around each track's location, across its state, and, when a track accepts remote work, with the site's own remote filter, since some sites label remote roles as on site. Eightfold and Oracle postings that every track rejects on location alone are listed as rejected without their full text being downloaded. Where a board lists titles only, a posting's text downloaded in a run of the last 30 days is not downloaded again while its title is unchanged. Add a company by name and JobSift finds its board on any of these except Workday, Oracle, and iCIMS, which are found from the company's careers page link. JobSift also learns boards from the apply links Jobright returns, and remembers every board it finds.
- Optionally imports your LinkedIn connections to mark roles at companies where you know someone, and, if you turn it on, to search those companies' job boards directly.
- Merges and de-duplicates all findings, then gives each role a match score out of 100 from four signals: how well the title matches the roles you listed, pay against your track's floor, your industries, and your skills. Scores become grades A (80+), B (65+) and C (50+). Each role on the Roles tab also says which tracks accept it and which dashboard tab its jobs appear under; each track sets which grades it accepts, along with its work arrangements, pay floor and commute radius (geocoded via OpenStreetMap Nominatim with a local cache). A posting that names only a state matches a track whose location is in that state, and remote work limited to one state is accepted when it is your home state (set in Settings) or a track's location is in it. A remote role that names an office within a track's commute range counts as in person at that office for that track, as companies near their offices usually expect. A posting whose only location is the country is taken as remote, since it names no site to work at; when Jobright labels such a posting on site, it is flagged to confirm.
- Labels every role with its employment type (Full-time, Contract and so on, or Not stated) and who posted it (the employer, a staffing firm, or a job board), and shows the same job posted by several companies once, listing the other copies. Postings made by job boards and reposting sites are rejected by default; each track can choose which employment types it accepts.
- Shows the results in a dashboard split into accepted and rejected roles, filterable by source, track, role type, employment type, who posted it, whether you have a connection there, and whether you applied.
- Remembers what you applied to. After you click Apply, the button asks whether you applied; answering Yes marks that posting in every run, past or future, for six months, including where it turns up again with the same posting ID. Records are kept only in `%APPDATA%/JobSift/applied.json`.
- Runs on demand from the tray or the dashboard, or on a regular schedule; a scheduled run missed while JobSift was closed starts a minute after it next opens. Each run writes a small log of what it did and how its requests went (tray menu, Open Log Folder); the newest 30 are kept.

## Requirements

To run a release:
- Windows (primary target; macOS build config is included).

To build:
- Node.js 22.12 or newer and npm, only to install the pinned dependencies and to run or package the app.

## Getting started

On first launch the setup wizard appears. It walks you through your first track, the roles you want (Ideal, Good, or Acceptable), industries and skills, company job boards, what to avoid, and, optionally, your LinkedIn connections, then drops you on the dashboard. Everything it sets can be changed later from the Configuration button on the dashboard or the Settings item in the tray.

Your settings are stored per user at `%APPDATA%/JobSift/config.json` (created from the blank template in `resources/config.json` on first run). The repo copy stays empty, so your personal config is never committed. A config from an earlier version is moved to the current layout the first time it loads; the original is kept beside it as `config.before-v<N>.json` (N being the new layout version), and the config page lists anything that could not be carried over.

## Connections

On the Connections tab of the config page (or the optional wizard step), import the connections file you export from LinkedIn (Settings -> Data privacy -> Download your data). Then:

- Every role, accepted or rejected, at a company where you know someone shows a badge such as "2 connections"; hover it or expand the role to see their names. Badges are worked out when a run is shown, so past runs get them too.
- With "Also search my connections' companies for jobs" turned on (it is off by default), each run also searches those companies' own job boards on any of those systems. The first run after turning it on looks up every company's board, which takes about 6 to 11 seconds per company; the Connections tab shows the estimate for your list before you turn it on, and its Check them now button runs the lookups right away instead of during the next search. Later runs search the boards found and look again for the rest after 30 days (`connections.recheck_days` in config.json). The Connections tab counts how many companies' boards are searched and how many rely on Jobright alone, and lists the companies whose boards are searched, including a board shared with a parent company (only roles that name the company are kept). A board JobSift can't find on its own can be added on the Sources tab. Entries such as "Freelance" or "Self-employed" are skipped.

Company names are compared after cleanup (case, punctuation, "&", a leading "the", and endings such as Inc or LLC), and only exact matches count, so different names for the same company (Meta and Facebook) do not match.

Privacy: JobSift keeps only each person's name and company, in `%APPDATA%/JobSift/connections.json`; the CSV is not copied. Names never leave your computer and never appear in logs or results files. Only company names are sent to job boards, to ask for their public listings. Remove deletes the file.

Boards found by any means are kept in `%APPDATA%/JobSift/known_boards.json`.

## Using

- Pick a scan period (past 24 hours, 3 days, week, or month) and press Run Now, from either the dashboard or the tray.
- Sign in to Jobright within the interface; the app detects your session automatically and continues.
- Past runs can be reopened from the Load Past Result picker.
- Each run leaves out roles an earlier run already accepted, unless how roles are judged has changed since then; roles an earlier run rejected are always judged again. Check Include previously seen to show everything.

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
│   ├── history.js           What earlier runs fetched: reuse, cleanup, Jobright coverage
│   ├── runlog.js            One log file per run: steps, requests, outcome
│   ├── eval.js              Evaluation engine: filters, tracks, grades
│   ├── criteria.js          Match score, grades and config migration
│   ├── sources.js           Employment type, who posted a job, duplicate postings, posting ids
│   ├── connections.js       LinkedIn connections: CSV reader, company-name matching
│   ├── applied.js           Roles you applied to: saving and matching
│   ├── boards.js            Known job boards, company-name lookup, apply-link learning
│   └── scraper/
│       ├── jobright.js      Jobright scraper (hidden BrowserWindow)
│       └── ats-http.js      Company job board scraper, one per hiring system
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
