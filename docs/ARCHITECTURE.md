# Sport-Tracker Monorepo — Architecture

A monorepo housing two independent Next.js PWAs that track live sports tournaments for family-oriented audiences. Shared infrastructure lives in `packages/core`.

---

## Directory Structure

```
SportTracker/
├── apps/
│   ├── volleywatch/              # AES volleyball tracker (208 U14 Red)
│   │   ├── pages/
│   │   │   ├── index.jsx         # Single-page app, tabbed UI
│   │   │   └── api/
│   │   │       ├── tournament.js     # AES adapter — main data endpoint
│   │   │       ├── bracket.js        # AES bracket structure
│   │   │       ├── snapshot.js       # Read a stored Blob snapshot
│   │   │       ├── snapshots.js      # List stored Blob snapshots
│   │   │       ├── calendar.ics.js   # iCal feed
│   │   │       └── push-{subscribe,unsubscribe,prefs,send}.js
│   │   ├── public/
│   │   │   ├── manifest.json     # PWA manifest
│   │   │   └── sw.js             # Service worker
│   │   ├── styles/globals.css
│   │   ├── next.config.js
│   │   └── .env.example
│   │
│   └── narwatch/           # Multi-source water polo tracker (North Idaho Narwhals)
│       ├── pages/
│       │   ├── index.jsx
│       │   └── api/
│       │       ├── tournament.js     # Data-source router (priority chain)
│       │       ├── niwp.js           # NIWP WordPress REST adapter
│       │       ├── tormatch.js       # TorMatch live adapter
│       │       ├── sixeight.js       # 6-8 Sports (USAWP JOs) adapter
│       │       ├── sportsengine.js   # TourneyMachine HTML scraper
│       │       ├── sheets.js         # Google Sheets live adapter
│       │       ├── historical.js     # Aggregate stats from data/ files
│       │       ├── stats.js          # Per-game NIWP player stats
│       │       ├── niwp-weeks.js     # NIWP week list
│       │       └── push-{subscribe,unsubscribe,prefs,send}.js
│       ├── lib/
│       │   ├── pollSchedule.js   # Smart polling interval engine
│       │   └── tournamentData.js # Static tournament seed data
│       ├── data/                 # Committed historical data (git-tracked)
│       │   ├── games.json
│       │   ├── players.json
│       │   ├── player_season_stats.json
│       │   ├── team_record.json
│       │   ├── tournament_summary.json
│       │   ├── game_flags.json
│       │   ├── opponent_normalization_map.json
│       │   └── team_normalization_map.json
│       └── scripts/
│           ├── harvest-niwp.js       # Pull all games+stats from NIWP API
│           ├── compute-aggregates.js # Rebuild data/ aggregates
│           ├── normalize-opponents.js
│           └── normalize-teams.js
│
├── packages/
│   └── core/                     # Shared server-side utilities
│       ├── blobStore.js           # Vercel Blob read/write wrappers
│       ├── push.js                # Web Push fan-out, ALERT_TYPES, pref schema
│       ├── snapshots.js           # Blob-backed tournament snapshot storage
│       ├── stateDiff.js           # Diff tournament payloads -> push events
│       ├── gameNorm.js            # deriveStandings() utility
│       └── package.json           # name: @sport-tracker/core
│
├── docs/                          # Monorepo-level docs (this directory)
├── package.json                   # npm workspaces root
└── WORKING_NOTES.md               # Living session log
```

---

## Tech Stack

| Concern | Choice |
|---------|--------|
| Framework | Next.js (Pages Router) |
| Deployment | Vercel (one project per app) |
| Package manager | npm workspaces |
| Shared code | `@sport-tracker/core` (local workspace package) |
| Persistent storage | Vercel Blob (push subscriptions, snapshots, state diffs) |
| Push notifications | Web Push (VAPID) via `web-push` npm package |
| PWA | `public/manifest.json` + hand-written `public/sw.js` |
| Styling | Plain CSS with custom properties (no Tailwind, no CSS Modules) |
| Runtime | Node 18+ (Vercel serverless functions) |

Both apps are single-page Next.js applications. All data-fetching is server-side (API routes); the frontend polls `/api/tournament` on a schedule and renders purely from the returned JSON.

---

## Data Flow

### VolleyWatch

```
Browser --poll /api/tournament--> tournament.js
         (2 min module-level cache      |
          + AES remote timestamp check) |  fetches in parallel:
                                        +-> results.advancedeventsystems.com
                                              /api/event/{id}
                                              /api/event/{id}/teams/{teamId}
                                              /api/event/{id}/division/{d}/team/{t}/schedule/current
                                              /api/event/{id}/division/{d}/team/{t}/schedule/future
                                              /api/event/{id}/division/{d}/team/{t}/schedule/work
                                              /odata/{id}/standings(dId={d},cId=null,tIds=[])
                                              /api/event/{id}/division/{d}/brackets
                                              /api/event/{id}/division/{d}/pools
                                              /api/event/{id}/timestamp  <- cache bust check

Response --> diffAndPush()   --> Vercel Blob (state persistence)
                             --> Web Push fan-out

Response --> maybeSnapshot() --> Vercel Blob (snapshots/{eventId}/*.json)
```

### NarWatch — Data Source Priority Chain

```
GET /api/tournament
       |
       +-- SIXEIGHT_ENABLED=true? -----------> sixeight.js (6-8 Sports)
       |
       +-- auto-probe 6-8 Sports (cached 2/10 min)
       |    Narwhal game in_progress or today? -> sixeight.js
       |
       +-- NIWP_API_ENABLED=true? -----------> niwp.js
       |    northidahowaterpolo.org/wp-json/niwp-stats/v1/games
       |                                                      /players
       |
       +-- TORMATCH_TOURNAMENT_ID set? ------> tormatch.js
       |    live.tormatch.com + scheduling.tormatch.com
       |
       +-- SPORTSENGINE_TOURNAMENT_ID set? --> sportsengine.js
       |    tourneymachine.com HTML scrape
       |
       +-- GOOGLE_SHEETS_ID set? -----------> sheets.js
       |    sheets.googleapis.com/v4/spreadsheets/{id}/values/...
       |
       +-- static fallback -----------------> lib/tournamentData.js
```

All six sources normalize to an **identical JSON payload shape**. The frontend is entirely source-agnostic.

---

## Vercel Project Mapping

| App directory | Vercel project | Project ID | rootDirectory |
|---------------|---------------|------------|---------------|
| `apps/VolleyWatch` | `volleywatch` | `prj_MvCekYapFB1Dog5r8qCyGPwAGLun` | `apps/VolleyWatch` |
| `apps/NarWatch` | `narwatch` | `prj_RTZprqmEXqD9DhmyrPOgR2e1P1ym` | `apps/NarWatch` |
| *(repo root)* | `sport-tracker` | `prj_rdepbE14qRVfGvZoxaogBVt4RUdR` | *(root)* |

**Critical:** `rootDirectory` is evaluated relative to the repo root. Never run `vercel --prod` from inside an app subdirectory — the path doubles and the build fails. Always deploy from the repo root, or rely on git-triggered builds.

---

## Deployment Pipeline

```
git push origin main
        |
        +-> Vercel: volleywatch project
        |       rootDirectory: apps/VolleyWatch
        |       runs: npm install && next build
        |       deploys to: volleywatch-app.vercel.app
        |
        +-> Vercel: narwatch project
                rootDirectory: apps/NarWatch
                runs: npm install && next build
                deploys to: narwhaltracker.vercel.app
```

Both builds are independent — a failure in one does not block the other. Both projects are Git-connected to the monorepo (wired 2026-05-02).

---

## Environment Variables

### VolleyWatch (`apps/VolleyWatch`)

| Variable | Description |
|----------|-------------|
| `EVENT_ID` | AES event ID (has hardcoded default; update each season) |
| `DIVISION_ID` | AES division ID |
| `TEAM_ID` | AES numeric team ID |
| `TEAM_NAME` | Display name shown in UI |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | VAPID public key (client-visible) |
| `VAPID_PRIVATE_KEY` | VAPID private key (server-only) |
| `VAPID_SUBJECT` | `mailto:` URI for VAPID |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token (auto-injected when Blob store linked) |

### NarWatch (`apps/NarWatch`)

| Variable | Description |
|----------|-------------|
| `NIWP_API_ENABLED` | `true` -> use NIWP WordPress REST adapter |
| `NIWP_TEAM_PREFIX` | Squad filter: `B` / `G` / `BJV` / `GJV` (default: `B`) |
| `SIXEIGHT_ENABLED` | `true` -> always use 6-8 Sports, skip auto-probe |
| `SIXEIGHT_DISABLED` | `true` -> never use 6-8 Sports |
| `SIXEIGHT_LEAGUE_ID` | Pin a specific JO league UUID; blank = auto-discover |
| `SIXEIGHT_TEAM_NAME` | Team name fragment (default: `Narwhal`) |
| `TORMATCH_TOURNAMENT_ID` | Numeric tournament ID on tormatch.com |
| `TORMATCH_TEAM_NAME` | Team fragment (default: `Narwhals`) |
| `SPORTSENGINE_TOURNAMENT_ID` | TourneyMachine hash ID from URL |
| `SPORTSENGINE_TEAM_NAME` | Team fragment (default: `Narwhal`) |
| `GOOGLE_SHEETS_ID` | Google Sheet ID from the URL |
| `GOOGLE_SHEETS_API_KEY` | Google Cloud API key (Sheets API v4) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | VAPID public key |
| `VAPID_PRIVATE_KEY` | VAPID private key |
| `VAPID_SUBJECT` | `mailto:` URI |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token |

---

## PWA Setup

Both apps follow the same PWA pattern:

- **`public/manifest.json`** — Web App Manifest. `display: "standalone"`, portrait orientation, 192/512px icon pair.
- **`public/sw.js`** — Hand-written service worker. Handles Web Push notification receipt and display. Does not offline-cache API responses (polling-based freshness model).
- **`pages/_document.jsx`** — Injects `<link rel="manifest">` and meta theme-color.
- **`pages/_app.jsx`** — Registers the service worker on first mount, manages VAPID subscription lifecycle.

Icons are generated from SVG source via `scripts/build-icons.mjs`.

Push alert types (from `packages/core/push.js`):

| ID | Label | Timing-aware |
|----|-------|--------------|
| `game-soon` | Game starting | Yes (user sets 5–90 min lead) |
| `live-score` | Live score updates | No |
| `final-result` | Final results | No |
| `schedule-change` | Schedule / court changes | No |
| `bracket-advance` | Bracket advancement | No |
| `work-soon` | Work duty reminder | Yes |

Push subscriptions live in Vercel Blob at `push-subs-{teamId}.json`. Dedup state lives at `state-{eventId}-{teamId}.json` (capped at 200 sent event keys to prevent unbounded blob growth).

---

## Shared Core Package (`packages/core`)

Imported as `@sport-tracker/core`. Both apps declare `transpilePackages: ['@sport-tracker/core']` in `next.config.js`.

| File | Key exports | Purpose |
|------|------------|---------|
| `blobStore.js` | `readJson`, `writeJson`, `blobConfigured` | Vercel Blob wrappers; graceful no-op when token absent |
| `push.js` | `ALERT_TYPES`, `defaultPrefs`, `prefValue`, `pushToTeam`, `pushConfigured` | Web Push fan-out, alert type registry, per-user pref schema |
| `snapshots.js` | `maybeSnapshot`, `listSnapshots`, `getSnapshot` | Rate-limited (1/5 min) snapshot writes; terminal snapshot on `event.isOver` |
| `stateDiff.js` | `diffAndPush` | Diffs `/api/tournament` payloads; fires push for result, court, time, and live-score changes |
| `gameNorm.js` | `deriveStandings` | Compute standings from normalized game array; used by NIWP and Sheets adapters |
