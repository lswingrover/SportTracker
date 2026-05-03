# NarWatch — Developer Guide

NarWatch is a PWA tournament and season tracker for the **North Idaho Narwhals** water polo teams. It is designed to handle multiple data sources — from live tournament platforms to a Google Sheet maintained by a team parent — with automatic fallback.

---

## Purpose and Audience

- **Who uses it:** Parents, players, and coaches of the North Idaho Narwhals
- **When they use it:** Tournament weekends (live scores), and throughout the season (season record, player stats)
- **What it shows:** Current tournament games/scores, team record, pool standings, player leaderboard, H2H history, and push notifications

---

## Architecture Overview

```
index.jsx
   |-- polls /api/tournament (adaptive interval via _pollSchedule)
   |-- subteam dropdown filter (18U Boys / 18U Girls / JV Boys / JV Girls / Dev)
   |-- tabs: Games | Standings | Stats
   |-- H2H panel (bottom sheet, lazy-loaded from /api/historical)
   +-- TZ toggle pill (local vs. Pacific)

/api/tournament.js  <-- data source router (priority chain)
   |-- probes 6-8 Sports (auto, no env var needed during JO season)
   |-- delegates to: niwp.js | tormatch.js | sixeight.js | sportsengine.js | sheets.js | static

/api/historical.js  <-- pre-computed stats from data/ directory
/api/stats.js       <-- per-game player stats from NIWP
```

---

## Data Source Priority Chain

`/api/tournament.js` acts as a router. It checks env vars and auto-probes in order, delegating to the first matching adapter. All adapters return an identical JSON payload shape.

### 1. 6-8 Sports (USAWP Junior Olympics) — Auto-detect

Used during USAWP Junior Olympics tournaments. No env var required for auto-detection.

The handler calls `probeNarwhalsGames()` from `sixeight.js` on every request (cached 2 min if active, 10 min if inactive). The probe fetches `/v2/leagues/links/` to auto-discover the active JO league, then scans games for any Narwhal game that is `in_progress` or scheduled today. If found, the full `sixeight.js` handler is invoked.

Override env vars:
- `SIXEIGHT_ENABLED=true` — always use 6-8 Sports (skip probe; useful for testing)
- `SIXEIGHT_DISABLED=true` — never use 6-8 Sports
- `SIXEIGHT_LEAGUE_ID` — pin a specific league UUID (skip auto-discovery)
- `SIXEIGHT_TEAM_NAME` — team name fragment (default: `Narwhal`)

### 2. NIWP WordPress REST API

Primary source for North Idaho Water Polo club tournaments.

```
NIWP_API_ENABLED=true
NIWP_TEAM_PREFIX=B   # B | G | BJV | GJV | D
```

### 3. TorMatch

For tournaments hosted on tormatch.com.

```
TORMATCH_TOURNAMENT_ID=258   # numeric ID from tormatch.com
```

The API key is baked into `tormatch.js` (it's a public/reverse-engineered key). Discovery: find the tournament on tormatch.com and pull the ID from the URL.

### 4. SportsEngine / TourneyMachine

HTML scraper for tournaments on tourneymachine.com.

```
SPORTSENGINE_TOURNAMENT_ID=<hash>  # IDTournament= param from URL
```

Discovery: Google `site:tourneymachine.com "Tournament Name"` and read the `IDTournament=` query param.

### 5. Google Sheets

Manual fallback — a team parent enters scores into a shared Google Sheet.

```
GOOGLE_SHEETS_ID=<sheet-id-from-url>
GOOGLE_SHEETS_API_KEY=<google-cloud-api-key>
```

See `docs/SHEETS_SETUP.md` for full setup (5 min). See also `DATA_SOURCES.md` for the sheet schema.

### 6. Static Fallback

Falls back to `lib/tournamentData.js`, which exports a `TOURNAMENTS` array of hardcoded tournament objects. The static data shape is the same normalized structure as all live adapters.

---

## NIWP WordPress REST API

**Base URL:** `https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1`

No authentication. Completely public. No documented rate limit.

### Endpoints

| Endpoint | Response |
|----------|---------|
| `GET /games` | All games, paginated. Returns `{success, data:[...]}` envelope. |
| `GET /players` | All registered players. Same envelope. |
| `GET /games/{id}/stats` | Per-game player stat lines. Same envelope. |

**Important:** Always unwrap the envelope:
```js
const data = Array.isArray(r) ? r : (r.data || []);
```

### Game Object Shape

```json
{
  "game_id": 131,
  "home_team": "CDA 18U Boys",
  "away_team": "Spokane Thunder",
  "home_score": 12,
  "away_score": 8,
  "game_date": "2026-04-17 18:30:00",
  "location": "Kroc Center, Spokane WA"
}
```

### `parseDateAsPT()` — Critical TZ Fix

The NIWP API stores `game_date` as a bare datetime string in Pacific wall-clock time (`"2026-04-17 18:30:00"`) with **no timezone offset**. Passing this to `new Date()` on a UTC server (Vercel) shifts times by 7–8 hours.

`parseDateAsPT()` in `niwp.js` detects bare strings, assumes PDT (`-07:00`) as a first attempt, then verifies via `Intl.DateTimeFormat` whether the date actually falls in PDT. If not (winter/PST), it re-parses with `-08:00`. This gives correct wall-clock times year-round.

### Team Name Normalization and `deriveSubteam()`

NIWP names CDA teams like `CDA 18U Boys`, `CDA 14U Co-Ed`, `CDA JV Girls`, etc. The `deriveSubteam()` function maps these to canonical squad keys:

| NIWP name contains | Squad key | Label |
|-------------------|-----------|-------|
| `boy` (no JV) | `B` | 18U Boys |
| `girl` (no JV) | `G` | 18U Girls |
| JV + no `girl` | `BJV` | JV Boys |
| JV + `girl` | `GJV` | JV Girls |
| `dev` or `co-ed` | `D` | Dev |

CDA teams are detected by checking `home_team` or `away_team` for the patterns: `cda`, `coeur d'alene`, `north idaho`, `narwhal`, `niwp` (case-insensitive).

### Stats Endpoint

Per-game player stats are served by `/api/stats.js` (not `/api/tournament.js`). Stats fields: `goals`, `assists`, `steals`, `blocks`, `kickouts`. The Stats tab lazy-loads these per game when the user expands a game row.

---

## TorMatch Adapter (`tormatch.js`)

Polls two TorMatch APIs:
- **Live:** `https://live.tormatch.com` — game status, scores
- **Scheduling:** `https://scheduling.tormatch.com` — match schedule, teams, standings

The API key in the source file (`ZbD09T1jkeF6aSD3719xnJAsoa83iSIFA`) is a reverse-engineered public key embedded in tormatch.com's own client.

The handler fetches 7 endpoints concurrently via `Promise.allSettled` (individual failures don't break the whole response):

```
/v2/tournaments/{id}           <- live tournament status
/tournaments/{id}              <- schedule tournament metadata
/tournaments/{id}/parts        <- tournament parts
/tournaments/{id}/matches      <- all matches
/tournaments/{id}/stages       <- bracket stages
/tournaments/{id}/teams        <- team list
/tournaments/{id}/rankings     <- standings
```

Teams are matched to Narwhals by checking if the name contains `"narwhal"` (case-insensitive, configurable via `TORMATCH_TEAM_NAME`).

---

## Google Sheets Adapter (`sheets.js`)

Three-tab schema (`Config`, `Games`, `Standings`). Column headers are order-flexible and matched case-insensitively via alias tables.

**Config tab** (column A = key, column B = value):

| Key | Purpose |
|-----|---------|
| `tournament_name` | Display name |
| `team_name` | Our team name (default: `North Idaho Narwhals`) |
| `team_id` | Slug (default: `narwhals`) |
| `location` | Venue |
| `date` | Tournament date (used as fallback game date) |

**Games tab** headers (flexible column order):
`Game ID | Date | Time | Round | Opponent | NIWP Score | Opp Score | W/L | Done | Court | Notes`

**Standings tab** headers:
`Rank | Team Name | Wins | Losses | Goal Diff | Is Us`

If the Standings tab is blank or absent, standings are auto-derived from the Games tab using `deriveStandings()` from `packages/core/gameNorm.js`.

---

## Smart Polling (`lib/pollSchedule.js`)

Polling intervals are adapted based on the current time relative to scheduled games. Data is based on 85 observed NIWP games: stats are entered by scorekeeper Ryan Curry, typically 45–75 min after game time.

| Mode | Trigger condition | Interval |
|------|------------------|----------|
| `live` | 30–90 min after game start (peak entry window) | 90 sec |
| `hot` | Within 30 min of game start, or 0–30 min after | 3 min |
| `cooldown` | 90–150 min after game start (tail of entry) | 5 min |
| `warm` | Game day, but between games | 10 min |
| `cold` | No games today | 4 hours |

The API response includes a `_pollSchedule` field that the frontend reads to set its next poll timer. This is a pure utility function — no I/O — importable from `lib/pollSchedule.js`.

---

## Historical Data (`data/` directory)

Pre-computed aggregate data committed to git. The `/api/historical` endpoint reads from these files; reads are essentially free (static disk files on Vercel).

| File | Contents |
|------|---------|
| `games.json` | All harvested games from NIWP API |
| `players.json` | All registered players |
| `player_season_stats.json` | Aggregated per-player season stats |
| `team_record.json` | Overall season W/L record by subteam |
| `tournament_summary.json` | Per-tournament summary |
| `opponent_normalization_map.json` | Maps raw opponent names to canonical names |
| `team_normalization_map.json` | Maps raw CDA team names to squad keys |
| `game_flags.json` | Manual flags for individual games (notable, override) |

### Refreshing the Data

```bash
# From apps/narwhaltracker/
node scripts/harvest-niwp.js        # Fetch all games + stats from NIWP API
node scripts/normalize-teams.js     # Apply team normalization map
node scripts/compute-aggregates.js  # Rebuild all aggregates
```

Or trigger remotely via `GET /api/historical?refresh=1` (re-runs the pipeline server-side; takes up to 2 min).

### H2H Panel

The H2H (head-to-head) bottom sheet lazy-loads from `/api/historical?view=games&opponent_name=<name>`. It shows all historical games against a given opponent. The opponent name is normalized using `opponent_normalization_map.json`.

---

## Key Frontend Features

### Subteam Dropdown Filter

A dropdown in the header filters all data to a specific squad:
- `B` = 18U Boys (default)
- `G` = 18U Girls
- `BJV` = JV Boys
- `GJV` = JV Girls
- `D` = Dev / Co-ed

When `NIWP_API_ENABLED=true`, the selected squad is forwarded as `?team=` to `/api/niwp.js`.

### Stats Tab

Player leaderboard with sortable columns (goals, assists, steals, blocks, kickouts). Columns are click-sortable. Soren Swingrover is highlighted by name for family reasons.

### TZ Toggle Pill

A small pill button in the header toggles all displayed game times between the venue's local timezone (inferred from the `location` field via `inferVenueTz()`) and Pacific Time. Useful for away tournaments in other timezones.

### Venue TZ Inference

`inferVenueTz()` in `niwp.js` matches the game's `location` string against a map of place-name patterns to IANA timezone names. Default is `America/Los_Angeles` (Pacific). Current mappings cover: Oregon, Idaho, Washington, Texas, Colorado, Arizona, Florida/Georgia/Carolinas.

---

## API Routes Summary

| Route | Source | Purpose |
|-------|--------|---------|
| `GET /api/tournament` | Router | Main data endpoint; delegates to active adapter |
| `GET /api/niwp` | NIWP | Direct NIWP fetch; accepts `?team=` and `?weekKey=` |
| `GET /api/tormatch` | TorMatch | Direct TorMatch fetch; accepts `?id=` |
| `GET /api/sixeight` | 6-8 Sports | Direct 6-8 Sports fetch; accepts `?leagueId=` |
| `GET /api/sheets` | Google Sheets | Direct Sheets fetch |
| `GET /api/stats?game_id=N` | NIWP | Per-game player stats |
| `GET /api/historical` | data/ files | Season aggregates; accepts `?view=` and `?refresh=1` |
| `GET /api/niwp-weeks` | NIWP | List all available week keys for the week selector |
| `GET /api/bracket` | AES | Bracket structure (AES only; unused for water polo currently) |
| `GET /api/snapshots` | Vercel Blob | List tournament snapshots |
| `GET /api/snapshot` | Vercel Blob | Read a specific snapshot |
| `GET /api/calendar.ics` | n/a | iCal feed |
| `POST /api/push-subscribe` | Vercel Blob | Register push subscription |

---

## Environment Variables

```bash
# Primary live source
NIWP_API_ENABLED=true
NIWP_TEAM_PREFIX=B            # B | G | BJV | GJV

# 6-8 Sports (USAWP JOs) — usually auto-detected; no vars needed
SIXEIGHT_ENABLED=             # true = force on
SIXEIGHT_DISABLED=            # true = force off
SIXEIGHT_LEAGUE_ID=           # optional: pin a league UUID
SIXEIGHT_TEAM_NAME=Narwhal    # team fragment for filtering

# TorMatch
TORMATCH_TOURNAMENT_ID=       # numeric ID from tormatch.com URL

# SportsEngine / TourneyMachine
SPORTSENGINE_TOURNAMENT_ID=   # hash from tourneymachine.com URL
SPORTSENGINE_TEAM_NAME=Narwhal

# Google Sheets fallback
GOOGLE_SHEETS_ID=
GOOGLE_SHEETS_API_KEY=

# Web Push
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@example.com
BLOB_READ_WRITE_TOKEN=        # Auto-injected by Vercel when Blob store is linked
```

---

## Known Data Gaps and Quirks

- **NIWP team name variants:** The same team may appear with slightly different spellings across games. Add new variants to `data/opponent_normalization_map.json` and run `compute-aggregates.js`.
- **`opponent_id` normalization:** NIWP doesn't expose a stable opponent ID, so H2H matching uses name normalization. Opponent canonical names live in `opponent_normalization_map.json`.
- **NIWP response envelope:** All three endpoints return `{success, data:[...]}`, not plain arrays. Always unwrap.
- **`game_date` timezone:** NIWP stores bare Pacific wall-clock datetimes. Always parse with `parseDateAsPT()` — never `new Date(dateStr)` directly on the server.
- **Stats field is `kickouts`** (not `ejections`, not `turnovers`).
- **TorMatch API:** Reverse-engineered. The API key and endpoint paths may change without notice.
- **6-8 Sports league discovery:** The probe uses `name.includes("junior")` to find JO leagues. If the league name changes, update `discoverLeague()` in `sixeight.js`.
