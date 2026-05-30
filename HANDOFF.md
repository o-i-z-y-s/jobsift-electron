# jobsift-electron — Development Handoff
# READ THIS IN FULL BEFORE TOUCHING ANY CODE

---

## 1. What This App Is

Jobsift automates job searching. It is a general-purpose tool — users configure their
own search terms, tracks, salary floors, target companies, and ATS boards via config.json.
The app makes no assumptions about the user's role, location, or salary requirements.

The pipeline:

1. Logs into Jobright.ai (an AI job aggregator) using the user's own account
2. Scrapes matching job listings by scrolling through search results
3. In parallel, makes HTTP calls to company ATS boards (Greenhouse, Lever, Ashby,
   Workday) for target companies that aren't on Jobright
4. Merges all results, deduplicates by ATS URL
5. Runs a scoring engine that evaluates each role against up to 3 "tracks"
6. Saves a structured JSON file with accepted (graded A/B/C) and rejected roles
7. Opens a dashboard to display the results

This project is `jobsift-electron`: a **native Electron desktop app** that delivers this
full pipeline to **non-technical end users** with a signed .exe installer and no setup
beyond installation.

The reference implementation is the Python pipeline at:
`C:\Users\Raskolnikov\Documents\GitHub\jobsift\`

---

## 2. The Track System

The scoring engine evaluates every role against one or more simultaneously-active "tracks."
The number of tracks, their names, and all their parameters are entirely user-defined in
`config.json` under `tracks[]`. Do not hardcode any track names, counts, salary values,
or geographic assumptions anywhere in the application code.

Each track has independent configuration for: salary floor, grade thresholds (grade_a,
grade_b, grade_c), accepted work types, target location and radius, score weights per
dimension, excluded companies, title filters, and target company bonuses.

A role is evaluated against every track in order. If it passes any track, it appears in
`accepted`. Post-eval, if the same ATS URL appears on multiple tracks, only the
highest-priority track is kept — priority follows the order of `tracks[]` in config.json
(index 0 = highest priority).

---

## 3. Pipeline Data Flow

```
[Jobright scraper]  →  job-search-jobright-TIMESTAMP.json
[ATS HTTP scraper]  →  job-search-ats-http-TIMESTAMP.json
         ↓
[Merge + dedup against prior runs]
         ↓
job-search-merge-TIMESTAMP.json  (staging, deleted on success)
         ↓
[eval_jobs scoring engine]
         ↓
Scrapes/Evaluated Scrapes/job-search-TIMESTAMP.json  (final output)
         ↓
[Dashboard reads this file]
```

In Electron: the pipeline runs in the **main process**. Progress events are sent to the
renderer via IPC. The dashboard BrowserWindow reads the output JSON.

---

## 4. Output JSON Format

The final evaluated file has this structure. The dashboard and all UI reads this format.

```json
{
  "scraped_at": "2026-05-29T14:30:00",
  "date": "2026-05-29",
  "days_ago": 7,
  "scan_label": "Past week",
  "accepted": {
    "count": 12,
    "roles": [
      {
        "jid": "unique-id",
        "track": "TRACK_KEY",
        "company": "Acme Corp",
        "title": "Senior Product Manager",
        "location": "Remote",
        "work_type": "remote",
        "salary": "$160,000 - $200,000",
        "ats_url": "https://boards.greenhouse.io/acme/jobs/12345",
        "apply_url": "https://...",
        "score": 18.5,
        "fit": "strong",
        "grade": "A",
        "role_cat": "Product",
        "dimensions": {
          "d1": 5, "d2": 4, "d3": 3, "d4": 4, "d5": 5, "d6": 4
        },
        "notes": "Target company; remote-confirmed",
        "prescreen": {
          "title": { "pass": true, "note": "Title accepted" },
          "domain": { "pass": true, "note": "D3=3 - software" }
        }
      }
    ]
  },
  "rejected": {
    "count": 47,
    "roles": [
      {
        "jid": "...",
        "track": "TRACK_KEY",
        "company": "...",
        "title": "...",
        "rejection_reason": "Salary below floor",
        "rejection_tier": "tier1",
        "score": 0,
        "grade": "R"
      }
    ]
  }
}
```

---

## 5. Scoring Dimensions (D1–D6)

Each accepted role receives scores on six dimensions. Scores are summed and compared
against per-track grade thresholds (`grade_a`, `grade_b`, `grade_c` in config.json).

| Dim | Name | What it scores |
|-----|------|----------------|
| D1 | Title & Level | Title quality vs. config `scoring.title_tiers` keyword lists |
| D2 | Scope | Breadth of responsibility vs. config `scoring.scope_tiers` |
| D3 | Domain | Industry/company domain vs. config `domain_scoring` tiers |
| D4 | Requirements | Technical depth vs. config `scoring.requirement_tiers` |
| D5 | Salary | Competitiveness vs. per-track salary thresholds |
| D6 | Work Arrangement | Work type fit (remote/hybrid/onsite) for the track |

Grades: **A** = score >= track.grade_a, **B** = >= grade_b, **C** = >= grade_c.

Score weights per dimension are configurable in `config.json` under `tracks[].score_weights`.

---

## 6. Config.json Structure

Config lives at `userData/config.json` (Electron's app data directory). On first run,
copy the template from `Config/config - clean.json` in the Python repo.

Key top-level sections:

```
tracks[]                - Array of track objects (user-defined keys and count). Each has:
                          key, label, work_types[], salary_floor, grade_a/b/c,
                          salary_score_5/4/3, target_location, target_radius_mi,
                          clearance_behavior, score_weights{d1..d5},
                          excluded_companies[], title_block[], title_require[],
                          target_companies[], level_cap_b[]

company_lists{}         - target_companies[], blocked_companies[],
                          blocked_agencies[], premium_agencies[]

title_filters{}         - title_require[], title_block[], card_exclude[]

ats_boards{}            - greenhouse{}, lever{}, ashby{}, workday_direct{},
                          workday_companies{}, workday_search_terms[]

settings{}              - min_match_pct, scroll_pause_ms, slow_mo, detail_workers

domain_scoring{}        - tier5[], tier4[], tier3[], tier2[]  (company name lists)

pipeline{}              - search_term, generate_copies{}, track_routing[]

scoring{}               - title_tiers[], scope_tiers[], requirement_tiers[]
                          (each tier: { score: N, keywords: [] } + default tier)

role_categories{}       - categories[]

rejection_filters{}     - max_experience_years, max_travel_pct,
                          blocked_industries[], description_blockers[]

jobright_searches{}     - passes[]  (each: id, label, taxonomy, work_model)
```

---

## 7. Jobright Scraper — Key Behaviors

Port from: `Py Files/jobright_scraper.py`

- **URL pattern**: `https://jobright.ai/jobs/search?q={term}&sortBy=match&jobType=...`
- **Login detection**: If `"login"` appears in `page.url`, session has expired. Show the
  login window.
- **Ant Design modals**: On fresh session load, Jobright shows 1–2 modal overlays.
  Dismiss with `button.ant-modal-close` (Ant Design component). Wait up to 3 seconds
  for each to appear; loop up to 3 times.
- **Scroll pattern**: Sort by "Top Matched". Scroll down, extract job cards, continue
  until match percentage on visible cards drops below `MIN_MATCH_PCT` (from config).
- **Multi-pass**: `config.jobright_searches.passes` defines multiple search passes
  (e.g., one for remote, one for local). Run each pass sequentially.
- **Detail extraction**: For each card, extract: company, title, location, work_type,
  salary range, responsibilities text, requirements text, ATS URL.
- **In Electron**: use hidden BrowserWindow + `webContents.executeJavaScript()` instead
  of Playwright. Session is shared from `session.defaultSession` (already logged in).

---

## 8. ATS HTTP Scraper — Key Behaviors

Port from: `Py Files/ats_scraper_http.py`

Uses plain `fetch()` (no browser). Company lists come from `config.ats_boards`.

- **Greenhouse**: `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs`
  Returns paginated JSON. Location enrichment: if location is vague (state-only),
  fetch the job detail endpoint to get `offices[].location`.
- **Lever**: `GET https://api.lever.co/v0/postings/{company}?mode=json`
- **Ashby**: GraphQL at `https://jobs.ashbyhq.com/api/non-user-graphql`
- **Workday**: company-specific API endpoints (`cxs` API or HTML fallback)

Output format must be **identical** to the Jobright scraper output so `eval_jobs.js`
merges them without special-casing.

---

## 9. Electron Window Architecture

```
Main process (hidden, always running)
│
├── System tray icon
│   └── Menu: "Run Now" | "Open Dashboard" | "Settings" | "Quit"
│
├── Login BrowserWindow (shown on first run or session expiry)
│   └── Loads https://jobright.ai — user logs in normally
│   └── On successful login, hide this window, store session
│
├── Config BrowserWindow
│   └── Loads ui/config/index.html
│   └── Opened from tray "Settings" or on first run post-login
│
└── Dashboard BrowserWindow
    └── Loads ui/dashboard/index.html
    └── Opened from tray "Open Dashboard" or after a scrape completes
```

The app should **minimize to tray** when windows are closed (not quit). Quit only via
the tray menu.

---

## 10. IPC API (preload.js contextBridge)

`ui/preload.js` must expose these APIs to renderer pages via `contextBridge.exposeInMainWorld`.
All async operations return Promises.

```js
window.electronAPI = {
  // Config
  loadConfig: () => Promise<object>,
  saveConfig: (config) => Promise<void>,

  // Scrape lifecycle
  startScrape: (options) => Promise<void>,   // options: { daysAgo: 1|3|7|30 }
  cancelScrape: () => Promise<void>,
  onScrapeProgress: (callback) => void,       // callback({ step, message, pct })
  onScrapeComplete: (callback) => void,       // callback({ outputPath, counts })
  onScrapeError: (callback) => void,          // callback({ message })

  // Results
  getLatestResult: () => Promise<object|null>,
  listResults: () => Promise<string[]>,       // list of output file paths
  loadResult: (path) => Promise<object>,

  // Auth
  isLoggedIn: () => Promise<boolean>,
  openLoginWindow: () => Promise<void>,

  // Scheduler
  getSchedule: () => Promise<object>,         // { enabled, cronHour, cronMinute }
  setSchedule: (schedule) => Promise<void>,

  // App
  getVersion: () => string,
  checkForUpdates: () => Promise<void>,
}
```

---

## 11. Existing UI Files to Adapt

These files already exist in the Python repo and contain all rendering logic.
**Adapt them, do not rebuild them.**

- **Dashboard**: `C:\Users\Raskolnikov\Documents\GitHub\jobsift\Scraper\UI\job-search-dashboard.html`
  Currently reads a JSON file from a local path. Adapt to call
  `window.electronAPI.getLatestResult()` instead. All rendering, filtering, and
  display logic stays intact.

- **Config UI**: The HTML that `config_ui.py` serves. Extract it from that Python file
  (it is embedded as a large string). The form fields and JS already match the
  config.json schema exactly. Adapt the save/load calls to use
  `window.electronAPI.saveConfig()` / `window.electronAPI.loadConfig()` instead
  of HTTP POST/GET to localhost.

---

## 12. Architecture Decisions (Final — Not For Re-Discussion)

- **Electron 42.3.0** — plain JavaScript, no TypeScript, no build step
- **No Playwright** — use Electron's own `BrowserWindow` + `webContents.executeJavaScript()`
- **No React, no Vue, no bundler** — vanilla HTML/JS for all UI
- **No external HTTP library** — Node 22 ships global `fetch()` with `AbortSignal.timeout()`
- **No scheduling library** — `setTimeout` computing ms-to-next-run
- **No SQLite or DB** — JSON files in `app.getPath('userData')` match the Python approach
- **Two production npm packages** + one dev: `electron`, `electron-updater`, `electron-builder`
- **Write everything we can ourselves** — if it's implementable in plain JS in under
  100 lines, we write it, we don't import it

---

## 13. Security Audit — Complete

A full audit of all 264 packages in the dependency tree was completed. The `package.json`
`overrides` block pins all vulnerable transitive dependencies to safe versions.

**CRITICAL RULE: Do not remove or modify the `overrides` block in `package.json`.**

### Accepted-Risk Items (documented, no action needed)

| Package | Risk | Decision |
|---|---|---|
| `got@11.8.6` | EOL — transitive dep of `@electron/get`, no currently unpatched CVEs | Accepted |
| `postject@1.0.0-alpha.6` | Alpha — legitimate electron-builder dep for SEA bundling | Accepted |
| `app-builder-bin@5.0.0-alpha.12` | Downloads Go binary — SHA512 checksums in electron-builder source | Accepted |
| `inflight@1.0.6` | Memory leak — build-time only, no CVE, no fix exists | Accepted |
| `glob@7.2.3` | Deprecated — cannot override, minimatch sub-dep patched via overrides | Accepted |
| `boolean@3.2.0` | Abandoned utility — no CVEs | Accepted |
| `lodash.isequal@4.5.0` | Deprecated — internal to electron-updater, cannot substitute | Accepted |
| `chromium-pickle-js@0.2.0` | Archived — used by app-builder-lib for ASAR, no CVEs | Accepted |

### Deprecation Warnings That Will Always Appear (expected)

`inflight@1.0.6`, `glob@7.2.3`, `boolean@3.2.0`, `lodash.isequal@4.5.0`

---

## 14. STRICT PACKAGE MANAGEMENT RULES

**These rules apply for the entire life of this project. No exceptions.**

1. **Never install a new npm package without explicit written permission from the user.**
   Do not run `npm install <anything>`. Do not add to `dependencies` or `devDependencies`.
   Do not suggest adding a package as an aside. If you think a task requires a new
   package, stop and ask the user explicitly before proceeding.

2. **If a new package is approved, perform a full security audit on that package AND
   its entire transitive dependency tree before installing.** Use parallel agents.
   Check: maintenance, CVEs (NVD + Snyk + OSV + GitHub Advisories + Socket.dev),
   supply chain incidents, binary downloads, postinstall scripts. No shortcuts.

3. **Always install with `--ignore-scripts`.**
   After install, run `node node_modules/electron/install.js` explicitly for the binary.
   No other install scripts should run.

4. **Never regenerate `package-lock.json` without explicit user permission.**
   The lockfile is clean and audited.

5. **Before reaching for any dependency, ask: can we write this in plain JS?**
   If yes, write it ourselves.

---

## 15. General Development Constraints

- **No em-dashes (`—`) or double-hyphens (`--`) in any user-visible text.** Use `-`.
- **Do not act on clarification or context alone.** Only act on explicit instruction
  verbs from the user ("build it", "write it", "go ahead", "do this", etc.).
- **Plain JS only.** `electron .` must start the app with zero compilation.
- **Windows-first.** Primary target is Windows 10/11 x64. Mac is secondary.
- **Do not invent behavior.** When porting from Python, read the source file first.
  Replicate what it does. Do not redesign.
- **No hardcoded role-specific copy.** All job-search-specific configuration lives in
  `config.json`, not in code.
- **Output JSON must match the format in Section 4 exactly.** The dashboard depends on it.

---

## 16. Build & Distribution (context only — do last)

`electron-builder.yml` is already written in the repo root. It targets NSIS `.exe`
installer for Windows. Distribution via GitHub Releases with `electron-updater`.
Code signing required before first public release — EV certificate or GitHub Actions
signing pipeline. Do not attempt a production build until all functionality is verified
with `npm start`.

---

## 17. Suggested Build Order

1. `src/config.js` — read/write `userData/config.json`; copy template on first run
2. `ui/preload.js` — contextBridge; expose `electronAPI` surface
3. `src/main.js` — app entry, tray, window management, IPC handler registration
4. `ui/login/index.html` — minimal page; main process loads jobright.ai in BrowserWindow
5. `src/scraper/ats-http.js` — port `ats_scraper_http.py`; no browser needed
6. `src/scraper/jobright.js` — port `jobright_scraper.py`; use hidden BrowserWindow
7. `src/eval.js` — port `eval_jobs.py`; pure logic, no I/O dependencies
8. `src/scheduler.js` — setTimeout scheduler; integrates with tray
9. `ui/config/index.html` — adapt existing config UI HTML
10. `ui/dashboard/index.html` — adapt existing dashboard HTML
11. Integration testing with `npm start`
12. Packaging with `npm run dist:win` (after signing setup)
