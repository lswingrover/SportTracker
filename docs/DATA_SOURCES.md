# Data Sources

All external data sources used by the sport-tracker monorepo.

---

## 1. AES — Advanced Event Systems (VolleyWatch)

**Base URL:** `https://results.advancedeventsystems.com`

**Auth:** None. All endpoints are public.

**Used by:** `apps/VolleyWatch/pages/api/tournament.js` and `bracket.js`

**Rate limits:** Undocumented. The server-side 2-minute cache keeps request volume low. Do not poll faster than every 60 seconds.

### Endpoint Map

```
GET /api/event/{eventId}
GET /api/event/{eventId}/teams/{teamId}
GET /api/event/{eventId}/division/{divId}/team/{teamId}/schedule/current
GET /api/event/{eventId}/division/{divId}/team/{teamId}/schedule/future
GET /api/event/{eventId}/division/{divId}/team/{teamId}/schedule/work
GET /odata/{eventId}/standings(dId={divId},cId=null,tIds=[])
GET /api/event/{eventId}/division/{divId}/brackets
GET /api/event/{eventId}/division/{divId}/pools
GET /api/event/{eventId}/timestamp
```

### Event ID Format

AES uses URL-safe base64 strings as event IDs (e.g., `PTAwMDAwNDI2MDU90`). To find the event ID for a new tournament: open the AES results page, open DevTools Network panel, and read the `eventId` segment from any API call.

### Known Quirks

- **Play-group format:** Schedule endpoints return `[{Play: {Courts:[...]}, Matches:[...]}]` — must be flattened before use. See `flattenPlayGroups()`.
- **`HasScores: false` on pool play:** Pool play matches show `HasScores: false` even when complete. Read `FirstTeamWon`/`SecondTeamWon` flags unconditionally.
- **`"NaN"` in SetPercent:** AES returns the string `"NaN"` for teams with zero sets. Use `parseFloat(x) || 0`.
- **Concluded tournaments return empty `/schedule/current`:** AES clears this after the event. Use bracket backfill via `extractTeamMatchesFromBrackets()`.
- **Team name trailing tags:** AES appends region identifiers like `" (EV)"` to bracket team-name text fields. Strip with `replace(/\s*\([^)]*\)\s*$/, '').trim()`.
- **`CourtAssignmentFlag` bitmask:** Bit 1 = PreviousMatchSameCourt, 2 = NextMatchSameCourt, 4 = NextMatchSameCourtIfWin, 8 = NextMatchSameCourtIfLoss, 16 = NotDefinite.

---

## 2. NIWP WordPress REST API (NarWatch)

**Base URL:** `https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1`

**Auth:** None. Fully public.

**Used by:** `apps/NarWatch/pages/api/niwp.js`, `stats.js`, `niwp-weeks.js`, and `scripts/harvest-niwp.js`

**Rate limits:** Undocumented. Server-side 60s cache is sufficient.

### Endpoints

```
GET /games              -> all games (no pagination observed)
GET /games/{id}/stats   -> per-game player stat lines
GET /players            -> all registered players
```

### Response Envelope

All endpoints return `{"success": true, "data": [...]}`. Always unwrap:
```js
const items = Array.isArray(r) ? r : (r.data || []);
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

### Stats Object Shape

```json
{
  "stat_id": 420,
  "player_id": 7,
  "player_name": "John Smith",
  "cap_number": "5",
  "goals": 3,
  "assists": 1,
  "steals": 2,
  "blocks": 0,
  "kickouts": 1
}
```

### Player Object Shape

```json
{
  "player_id": 7,
  "player_name": "B - John Smith"
}
```

The player name carries a team prefix (`B - `, `G - `, `BJV - `, `GJV - `) that identifies which squad the player belongs to.

### Known Quirks

- `game_date` is bare Pacific wall-clock time with no TZ offset. Always parse with `parseDateAsPT()` in `niwp.js`, never with `new Date(dateStr)` directly on a UTC server.
- The stats field is `kickouts` (not `ejections` or `turnovers`).
- CDA team names follow the pattern `CDA {age}U {gender}` (e.g., `CDA 18U Boys`, `CDA JV Girls`). Detect CDA teams by checking for `"cda"`, `"north idaho"`, `"narwhal"`, or `"niwp"` in the team name.

---

## 3. TorMatch (NarWatch)

**Live API base:** `https://live.tormatch.com`

**Scheduling API base:** `https://scheduling.tormatch.com`

**Auth:** Bearer token in `Authorization` header (live) / `Authentication` header (scheduling). The key `ZbD09T1jkeF6aSD3719xnJAsoa83iSIFA` is reverse-engineered from tormatch.com's client bundle. It is public/shared and may change.

**Used by:** `apps/NarWatch/pages/api/tormatch.js`

### Endpoints Used

```
GET https://live.tormatch.com/v2/tournaments/{id}
GET https://scheduling.tormatch.com/tournaments/{id}
GET https://scheduling.tormatch.com/tournaments/{id}/parts
GET https://scheduling.tormatch.com/tournaments/{id}/matches
GET https://scheduling.tormatch.com/tournaments/{id}/stages?no_draft_rounds=true
GET https://scheduling.tormatch.com/tournaments/{id}/teams
GET https://scheduling.tormatch.com/tournaments/{id}/rankings
```

### Tournament ID Discovery

Find the tournament on `https://tormatch.com`, navigate to the tournament page, and read the numeric ID from the URL. Set it as `TORMATCH_TOURNAMENT_ID`.

### Notes

- Fetches are `Promise.allSettled` — individual endpoint failures don't break the response.
- Teams response has a nested wrapper: `{data: {teams: [...]}}`. The adapter handles multiple unwrap shapes.
- This is a reverse-engineered integration. API paths and auth may change without notice.

---

## 4. 6-8 Sports (NarWatch — USAWP Junior Olympics)

**Base URL:** `https://api.6-8sports.com/api`

**Auth:** None. Fully public API.

**Used by:** `apps/NarWatch/pages/api/sixeight.js`

### Endpoints

```
GET /v2/leagues/links/                             -> active league list (for auto-discovery)
GET /v2/leagues/{leagueId}/games/?limit=100&offset=N  -> paginated game list
GET /v2/leagues/{leagueId}/teams/                 -> team standings
```

### League Discovery

The handler calls `/v2/leagues/links/` and finds the first entry whose name contains `"junior"`, `"jo"`, or `"olympic"`. The league ID can be pinned via `SIXEIGHT_LEAGUE_ID` to skip discovery.

### Game Object Shape

```json
{
  "pk": 12345,
  "dark_team_name": "North Idaho Narwhals 18U Boys",
  "light_team_name": "Spokane Thunder",
  "dark_team_score": 8,
  "light_team_score": 6,
  "in_progress": false,
  "schedule_date": "2026-06-14",
  "schedule_time": "14:30:00",
  "name": "Pool Play"
}
```

Scores are stored as `dark_team_score` / `light_team_score` (dark/light caps, not home/away). Times are stored as separate `schedule_date` and `schedule_time` fields in UTC.

### Auto-Detection Probe

The probe (`probeNarwhalsGames()`) is called on every `/api/tournament` request outside JO season with negligible overhead (cached 10 min when inactive). During JO season (any Narwhal game today or live), the cache TTL drops to 2 min and the full handler takes over.

---

## 5. Google Sheets API v4 (NarWatch)

**Base URL:** `https://sheets.googleapis.com/v4/spreadsheets`

**Auth:** API key (public sheet — no OAuth required). Restrict the key to Sheets API only in Google Cloud Console.

**Used by:** `apps/NarWatch/pages/api/sheets.js`

### Setup (5 minutes)

1. Create a new Google Sheet and set it to "Anyone with the link can view."
2. Create three tabs exactly named: `Config`, `Games`, `Standings`.
3. In **Config** tab (A = key, B = value), add: `tournament_name`, `team_name`, `location`, `date`.
4. In **Games** tab, add headers in row 1 (flexible order, case-insensitive):
   `Game ID | Date | Time | Round | Opponent | NIWP Score | Opp Score | W/L | Done | Court | Notes`
5. The **Standings** tab is optional — leave blank to auto-derive from Games.
6. Create a Google Cloud API key at console.cloud.google.com → APIs & Services → Credentials. Restrict to Sheets API v4.
7. Set `GOOGLE_SHEETS_ID` (the long ID from the sheet URL) and `GOOGLE_SHEETS_API_KEY` in Vercel environment variables.

### Column Aliases

The `Games` tab parser accepts many header name variants per column. For example, "our score" column accepts: `niwp score`, `niwp`, `us score`, `our score`, `score (niwp)`, `narwhals score`, `home`. The full alias map is in `sheets.js`.

### Cache

60-second module-level cache. Stale-on-error: if a Sheets fetch fails, the last successful payload is served with `cached: true`.

---

## 6. SportsEngine / TourneyMachine (NarWatch)

**Target:** `https://tourneymachine.com`

**Auth:** None. HTML scrape.

**Used by:** `apps/NarWatch/pages/api/sportsengine.js`

### Tournament ID Discovery

Google: `site:tourneymachine.com "Your Tournament Name"`. Click the result and read the `IDTournament=` query parameter from the URL.

Set as `SPORTSENGINE_TOURNAMENT_ID`.

---

## 7. Exposure Events

**Status:** WAF-blocked from cloud infrastructure.

Exposure Events runs a web application firewall that rejects requests from AWS, GCP, Azure, and Vercel IP ranges. Server-side scraping is not feasible.

**Workaround:** Use their iframe embed path. The embed URL is in the format `https://www.exposureevents.com/Events/Tournament?tournamentId=<id>&embed=true`. If you need live data from Exposure Events, contact them at `apps@exposureevents.com` to request API access or a whitelisted IP.

---

## Normalized Payload Shape

All adapters return an identical JSON shape so the frontend is source-agnostic:

```json
{
  "teamName": "North Idaho Narwhals",
  "teamId": "narwhals",
  "tournamentId": "niwp-2026-W20",
  "event": {
    "id": "niwp-2026-W20",
    "name": "Kroc Center · May 15, 2026",
    "location": "Kroc Center, Spokane WA",
    "startDate": "2026-04-17",
    "endDate": "2026-04-17",
    "isOver": false
  },
  "record": { "wins": 3, "losses": 1 },
  "goalDiff": 14,
  "games": [
    {
      "id": "131",
      "opponent": "Spokane Thunder",
      "subteam": "B",
      "timeISO": "2026-04-17T18:30:00.000Z",
      "court": "Kroc Center, Spokane WA",
      "done": true,
      "result": "W",
      "sets": [{ "us": 12, "them": 8 }],
      "score": "12-8",
      "round": null,
      "_source": "niwp"
    }
  ],
  "standings": [...],
  "venueTz": "America/Los_Angeles",
  "_dataSource": "niwp",
  "_pollSchedule": {
    "mode": "cold",
    "intervalMs": 14400000,
    "label": "cold",
    "nextGameISO": null
  }
}
```

The `_dataSource` and `_pollSchedule` fields are NarWatch-specific (not present in VolleyWatch responses). The core `games`, `standings`, `record`, and `event` fields are identical across all adapters.
