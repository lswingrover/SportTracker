# VolleyWatch — Developer Guide

VolleyWatch is a PWA tournament tracker for the **208 U14 Red** volleyball team. It pulls live data from the Advanced Event Systems (AES) API and displays schedule, standings, work duties, bracket results, and push notifications — all optimized for a phone in a gym.

---

## Purpose and Audience

- **Who uses it:** Parents and coaches of the 208 U14 Red club volleyball team
- **When they use it:** Tournament days, on their phone, in a gym with spotty cell service
- **What it shows:** Today's schedule, live scores (when AES has them), pool standings, bracket position, court work duty assignments, and push notifications for game results/court changes

---

## Architecture Overview

Single Next.js page (`pages/index.jsx`) that polls `/api/tournament` every ~2 minutes and re-renders from the response JSON. All AES fetching and normalization happens server-side in `pages/api/tournament.js`. The frontend has zero external dependencies — plain React + CSS custom properties.

```
index.jsx
   |-- polls /api/tournament (2 min interval)
   |-- renders tabs: Schedule | Standings | Duties | Bracket
   +-- push subscription UI (bell icon)

/api/tournament.js
   |-- fetches 9 AES endpoints in parallel (Promise.all)
   |-- normalizes into canonical game/standings/work shape
   |-- writes state diff to Vercel Blob -> push notifications
   +-- writes snapshot to Vercel Blob (rate-limited)
```

---

## AES API

**Base URL:** `https://results.advancedeventsystems.com`

No authentication required. All endpoints are public JSON APIs. AES uses a URL-safe base64 string as the event ID (e.g., `PTAwMDAwNDI2MDU90`).

### Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /api/event/{eventId}` | Event metadata (name, location, dates, `IsOver`) |
| `GET /api/event/{eventId}/teams/{teamId}` | Our team info (`WatchNowLink`, `TeamName`) |
| `GET /api/event/{eventId}/division/{divId}/team/{teamId}/schedule/current` | Completed matches |
| `GET /api/event/{eventId}/division/{divId}/team/{teamId}/schedule/future` | Upcoming matches |
| `GET /api/event/{eventId}/division/{divId}/team/{teamId}/schedule/work` | Work duty assignments |
| `GET /odata/{eventId}/standings(dId={divId},cId=null,tIds=[])` | Division standings (OData) |
| `GET /api/event/{eventId}/division/{divId}/brackets` | Full bracket tree |
| `GET /api/event/{eventId}/division/{divId}/pools` | Pool assignments and pool-play records |
| `GET /api/event/{eventId}/timestamp` | `LastUpdatedTimestamp` for cache busting |

All nine are fetched concurrently via `Promise.all`. Individual failures are swallowed with `.catch(() => fallback)` so a single flaky endpoint doesn't break the whole response.

### Caching Strategy

The handler maintains a module-level `Map` (`cacheByKey`) keyed on `eventId|divisionId|teamId`. TTL is 2 minutes. On cache hit, the handler checks AES's `/timestamp` endpoint: if `LastUpdatedTimestamp` hasn't changed, the cached payload is returned immediately (no full refetch). The `?force=1` query param bypasses both checks.

### Play-Group Format and `flattenPlayGroups()`

Schedule endpoints (`/schedule/current`, `/schedule/future`) return a play-group-wrapped array:

```json
[
  {
    "Play": { "Courts": [{ "Name": "Court 5", ... }] },
    "Matches": [ { ...match }, { ...match } ]
  }
]
```

The `flattenPlayGroups()` function in `tournament.js` flattens this into a plain match array, injecting the `Play.Courts[0]` court onto any match that lacks its own `Court` field. Without this, court assignments are missing from many matches.

### Team ID Awareness

The `normalizeMatch()` function receives `teamId` and uses it to determine which side of the match is "us." AES exposes `FirstTeamId` / `SecondTeamId` on each match. Correct team-side detection is critical for:

- Reading `FirstTeamWon` / `SecondTeamWon` flags (pool play W/L)
- Extracting the opponent name (the other team)
- Determining set score orientation (our score vs. their score)

### `HasScores` Quirk

Pool play matches frequently have `HasScores: false` even when `FirstTeamWon` / `SecondTeamWon` flags are set. The code reads W/L from explicit win flags **regardless of `HasScores`**. Do not gate on `HasScores` to determine if a match is complete.

### AES `NaN` / `SetPercent` Quirk

AES sometimes returns the string `"NaN"` for `SetPercent` in standings rows. The normalization code does `parseFloat(r.SetPercent ?? 0) || 0` to collapse this to `0` rather than propagating `NaN` to the frontend.

### Bracket Backfill

When a tournament ends, `/schedule/current` returns `[]` — AES clears it. But the brackets blob still contains the full match history. `extractTeamMatchesFromBrackets()` performs a deep walk of the bracket tree to surface all our team's matches as "past games," even after the tournament concludes. Pool-play matches are not in the bracket blob and can't be recovered this way.

---

## Key Functions in `tournament.js`

| Function | Purpose |
|----------|---------|
| `flattenPlayGroups(raw)` | Unwrap AES play-group format; inject court from group when absent on match |
| `normalizeMatch(m, opts)` | Canonical match shape from raw AES match; handles TeamId-aware opponent/score resolution |
| `normalizeWork(w, idx)` | Canonical work duty shape |
| `normalizeStandings(rows, teamId)` | Canonical standings row shape; handles `NaN` SetPercent |
| `buildBracketStructure(bracket, teamIdStr)` | Walk a single bracket tree, emit flat match list with depth/feedsInto metadata |
| `extractTeamMatchesFromBrackets(brackets, teamId)` | Deep-walk brackets blob for our team's matches |
| `extractBracketsForTeam(brackets, teamId)` | Filter full bracket list to only brackets containing our team |
| `extractPoolForTeam(pools, teamId)` | Find our pool and return pool standings + team list |
| `detectLive(m, opponent)` | Heuristic: is this match currently in progress? (scheduled in last 4h, not finalized) |
| `courtStayHints(m)` | Decode `WorkTeamCourtAssignmentFlag` bitmask into stay/stayIfWin/stayIfLoss hints |
| `buildResponse(...)` | Assemble the full canonical response payload |

---

## API Response Shape

`GET /api/tournament` returns:

```json
{
  "teamName": "208 U14 Red",
  "teamId": "201772",
  "eventId": "PTAwMDAwNDI2MDU90",
  "divisionId": "203854",
  "event": { "id", "name", "location", "startDate", "endDate", "isOver" },
  "record": { "wins": 2, "losses": 1 },
  "poolPosition": "2nd",
  "nextGame": { "time", "timeISO", "court", "opponent", "minutesUntil", "isRunningLate" },
  "nextEvent": { "kind": "game"|"work", ... },
  "liveGame": { "setIndex", "setNumber", "us", "them", "setsWon", "opponent", "court", ... },
  "projectedDone": "2026-04-19T20:30:00Z",
  "projectedDoneSource": "scheduled"|"estimate",
  "games": [ { "id", "done", "result", "score", "sets", "court", "opponent",
               "time", "timeISO", "endISO", "courtStay", "live", "next", "videoLink" } ],
  "standings": [ { "teamId", "teamName", "isUs", "rank", "matchesWon", "matchesLost",
                   "setsWon", "setsLost", "setPercent", "pointRatio", "earnedBid" } ],
  "workAssignments": [ { "id", "role", "court", "timeISO", "time", "teams" } ],
  "brackets": [ { "bracketId", "name", "order", "matches": [...] } ],
  "pool": { "poolName", "teams": [...] },
  "teams": [ { "teamId", "teamName", "club" } ],
  "scrapedAt": "2026-04-19T18:00:00Z",
  "cached": false
}
```

---

## Smart Default Tournament Logic

The tournament selector is pre-populated using a "smart default" heuristic: prefer tournaments that started within the last 7 days. This means after a Saturday tournament, VolleyWatch still shows Saturday's data on Sunday morning without requiring the user to reselect.

The last-selected tournament is persisted in `localStorage` under the key `vw_last_tournament`. On load, the app checks if the persisted tournament is still in the list (it may have been removed for off-season) before restoring it.

---

## Frontend Tabs

| Tab | Content |
|-----|---------|
| **Schedule** | Chronological game list; upcoming games first; "Running late" badge when scheduled time has passed; live score banner when `liveGame` is present |
| **Standings** | Pool standings table from AES OData endpoint; our team highlighted |
| **Duties** | Work duty assignments from `/schedule/work`; sorted by time |
| **Bracket** | Visual bracket tree built from `brackets[]` in the response; shows our path highlighted |

The refresh button shows different states: idle, loading, and error. It also shows the time since last successful fetch.

---

## Environment Variables

```bash
EVENT_ID=PTAwMDAwNDI2MDU90    # AES event ID (update each season)
DIVISION_ID=203854             # AES division ID
TEAM_ID=201772                 # AES numeric team ID
TEAM_NAME="208 U14 Red"        # Display name

# Web Push (optional — app works without these)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
BLOB_READ_WRITE_TOKEN=...      # Auto-injected by Vercel when Blob store is linked
```

To get `EVENT_ID` and `DIVISION_ID` for a new tournament: open the AES results page, inspect the network requests, and pull the IDs from any API call. The event ID is always the URL-safe base64 string.

---

## CSS and Theming

Styles are in `styles/globals.css` using CSS custom properties. Key variables:

```css
--color-bg          /* page background */
--color-surface     /* card/panel background */
--color-accent      /* primary blue (#1E3EBF) */
--color-win         /* green */
--color-loss        /* red */
--color-text        /* primary text */
--color-text-muted  /* secondary text */
```

No component library. No Tailwind. All layout is flexbox/grid in global CSS.

---

## Known Data Quirks

- **`NaN` in `SetPercent`:** AES returns the string `"NaN"` for teams with zero sets played. Always use `parseFloat(...) || 0`.
- **`HasScores: false` with win flags set:** Pool play. Read `FirstTeamWon`/`SecondTeamWon` unconditionally. Don't gate on `HasScores`.
- **Play-group format:** Schedule endpoints are wrapped — always call `flattenPlayGroups()` before normalizing.
- **Concluded tournament returns empty schedule:** Use bracket backfill via `extractTeamMatchesFromBrackets()`.
- **Team name trailing tags:** AES appends region tags like " (EV)" to team names in bracket text fields. The `bracketMatchToGame()` function strips these: `replace(/\s*\([^)]*\)\s*$/, '').trim()`.
- **`CourtAssignmentFlag` bitmask:** The court-stay hint bitmask uses two separate fields (`FirstTeamWorkTeamCourtAssignmentFlag` / `SecondTeamWorkTeamCourtAssignmentFlag`). OR them together since we don't always know which side is ours.
