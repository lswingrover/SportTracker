# Contributing to SportTracker

This is a Next.js monorepo holding two PWAs:

- `apps/NarWatch` — North Idaho Narwhals water polo tracker (deployed to `narwatch.vercel.app`)
- `apps/VolleyWatch` — 208 U14 Red volleyball tracker (deployed to `volleywatch-app.vercel.app`)

Both apps use the Next.js **pages router**, share `packages/` workspaces, and auto-deploy from `main` via Vercel.

## Local dev

```bash
git clone https://github.com/lswingrover/SportTracker.git
cd SportTracker
npm install
npm --prefix apps/NarWatch run dev      # http://localhost:3000
npm --prefix apps/VolleyWatch run dev   # http://localhost:3000
```

To exercise live data sources locally (NIWP, 6-8, TorMatch, SportsEngine, Sheets), set the relevant `*_API_ENABLED` / `*_TOURNAMENT_ID` env vars described in each app's `pages/api/tournament.js` header.

Before pushing: `npm --prefix apps/<app> run build` should pass.

## Branch naming

`<type>/<short-kebab-description>` — e.g. `perf/narwatch-instant-load`, `fix/volleywatch-tz-drift`, `docs/contributing-md`.

Types: `feat`, `fix`, `perf`, `docs`, `chore`, `refactor`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.

- Scope is the app or area: `narwatch`, `volleywatch`, `monorepo`.
- Subject is imperative, under ~70 chars: `fix(narwatch): gate first load on niwpFetchSettled to drop double-render`.
- Body explains the *why*, not the *what*. The diff shows what.
- Each commit should be a coherent unit of change — split unrelated work into separate commits.

## Pull requests

Open a PR against `main`. Default merge strategy: **squash merge**. PR title becomes the squash commit subject, so write it like a commit subject.

PR body should hit four things:

```markdown
## Summary
<2-3 sentences — what this changes and why>

## What changed
- Bulleted file-level summary

## Risk
<reversibility, blast radius, what to watch in prod>

## Test plan
- [x] What you ran and confirmed
- [ ] What still needs human eyeballs
```

Link to the issue with `Closes #N` (or `Refs #N` for partial work).

## Issues and labels

File issues against `lswingrover/SportTracker`. Use labels:

- **Area:** `area:narwatch`, `area:volleywatch`, `area:monorepo`
- **Type:** `type:bug`, `type:feat`, `type:perf`, `type:docs`, `type:chore`

For an issue to be actionable, it should describe: the symptom, the audit (what you found), the proposed fix, and the test plan.

## Deployment

Both apps auto-deploy from `main` on merge via Vercel. There is no manual deploy step. To preview a PR before merge, open the deployment URL Vercel posts on the PR.


---

## Technical Reference

### Architecture

```
pages/index.jsx               ← single-page app; all UI state lives here
  ├─ polls /api/tournament    (adaptive interval via _pollSchedule)
  ├─ subteam dropdown         (B / G / BJV / GJV / D)
  ├─ tabs: Games | Standings | Stats
  ├─ H2H panel                (bottom sheet; lazy-loaded via next/dynamic)
  └─ TZ toggle pill           (local ↔ Pacific)

pages/api/tournament.js       ← data source router (priority chain below)
pages/api/historical.js       ← pre-computed stats from data/ directory
pages/api/stats.js            ← per-game player stats from NIWP
components/LeaderboardCluster.jsx  ← lazy chunk: LeaderboardTab, PlayerSheet, H2HSheet
```

The `LeaderboardCluster` chunk is deferred via `next/dynamic` — it is not downloaded until the user first taps the Stats tab or opens a sheet.

---

### Data source priority chain

`/api/tournament.js` tries sources in order and delegates to the first match. All adapters return the same normalized JSON shape.

| Priority | Source | Activation |
|----------|--------|------------|
| 1 | **6-8 Sports** (USAWP Junior Olympics) | Auto-detected via probe — no env var needed. Override: `SIXEIGHT_ENABLED=true` / `SIXEIGHT_DISABLED=true` |
| 2 | **NIWP WordPress REST API** | `NIWP_API_ENABLED=true` |
| 3 | **TorMatch** | `TORMATCH_TOURNAMENT_ID=<numeric id>` |
| 4 | **SportsEngine / TourneyMachine** | `SPORTSENGINE_TOURNAMENT_ID=<hash>` |
| 5 | **Google Sheets** | `GOOGLE_SHEETS_ID=<id>` + `GOOGLE_SHEETS_API_KEY=<key>` — see `docs/SHEETS_SETUP.md` |
| 6 | **Static fallback** | Always active as last resort (`lib/tournamentData.js`) |

---

### NIWP WordPress REST API

**Base URL:** `https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1`
No auth, no documented rate limit.

| Endpoint | Returns |
|----------|---------|
| `GET /games` | All games — `{success, data:[...]}` envelope |
| `GET /players` | All players — same envelope |
| `GET /games/{id}/stats` | Per-game stat lines — same envelope |

**Always unwrap the envelope:**
```js
const data = Array.isArray(r) ? r : (r.data || []);
```

**`parseDateAsPT()` — critical TZ fix.** NIWP stores `game_date` as a bare Pacific wall-clock string with no offset (`"2026-04-17 18:30:00"`). On Vercel (UTC), `new Date(dateStr)` shifts times 7–8 h. Always use `parseDateAsPT()` from `niwp.js` — it detects bare strings and applies the correct PDT/PST offset.

**Team name normalization.** NIWP names CDA teams as `CDA 18U Boys`, `CDA JV Girls`, etc. `deriveSubteam()` maps these to squad keys used throughout the app:

| Pattern in NIWP name | Squad key | Label |
|----------------------|-----------|-------|
| `boy` (no JV) | `B` | 18U Boys |
| `girl` (no JV) | `G` | 18U Girls |
| JV, no `girl` | `BJV` | JV Boys |
| JV + `girl` | `GJV` | JV Girls |
| `dev` or `co-ed` | `D` | Dev |

CDA teams are detected by checking for: `cda`, `coeur d'alene`, `north idaho`, `narwhal`, `niwp` (case-insensitive).

---

### TorMatch adapter

Polls two TorMatch hosts concurrently via `Promise.allSettled`:
- **Live:** `https://live.tormatch.com` — scores and status
- **Scheduling:** `https://scheduling.tormatch.com` — schedule, teams, standings

The API key in `tormatch.js` is reverse-engineered from the tormatch.com client bundle. It may change without notice.

To find a tournament ID: open tormatch.com, navigate to the tournament, and read the numeric ID from the URL.

---

### Smart polling

`/api/tournament` responds with a `_pollSchedule` field that the frontend reads to set its next poll timer. Intervals adapt based on scheduled game times:

| Mode | When | Interval |
|------|------|----------|
| `live` | 30–90 min after game start | 90 sec |
| `hot` | Within 30 min of start, or 0–30 min after | 3 min |
| `cooldown` | 90–150 min after game start | 5 min |
| `warm` | Game day, between games | 10 min |
| `cold` | No games today | 4 hours |

Implementation: `lib/pollSchedule.js` — pure utility, no I/O.

---

### Historical data (`data/` directory)

Pre-computed aggregate files committed to git. `/api/historical` reads them as static disk files — essentially free on Vercel.

| File | Contents |
|------|---------|
| `games.json` | All harvested games from NIWP |
| `players.json` | All registered players |
| `player_season_stats.json` | Per-player season aggregates |
| `team_record.json` | Season W/L by subteam |
| `tournament_summary.json` | Per-tournament summary |
| `opponent_normalization_map.json` | Raw opponent name → canonical |
| `team_normalization_map.json` | Raw CDA team name → squad key |
| `game_flags.json` | Manual flags per game |

**Refreshing:**
```bash
cd apps/NarWatch
node scripts/harvest-niwp.js        # fetch all games + stats from NIWP
node scripts/normalize-teams.js     # apply team normalization
node scripts/compute-aggregates.js  # rebuild all aggregates
```
Or trigger remotely: `GET /api/historical?refresh=1` (takes up to 2 min).

---

### Key frontend features

**Subteam dropdown.** Filters all data to a squad (B / G / BJV / GJV / D). Selected squad is forwarded as `?team=` to NIWP when `NIWP_API_ENABLED=true`.

**Stats tab.** Sortable player leaderboard (goals, assists, steals, blocks, kickouts). Click any column header to sort. Tap a row to open the PlayerSheet.

**H2H panel.** Bottom sheet with full head-to-head history vs. an opponent. Lazy-loads from `/api/historical?view=games`. Once opened, the component stays mounted so the CSS slide-out animation plays on close (GH#18 fix).

**TZ toggle pill.** Switches displayed game times between venue local time and Pacific. Venue TZ is inferred from the `location` field via `inferVenueTz()` in `niwp.js` — default is `America/Los_Angeles`.

---

### API routes

| Route | Purpose |
|-------|---------|
| `GET /api/tournament` | Main data endpoint; delegates to active adapter |
| `GET /api/niwp` | Direct NIWP fetch; accepts `?team=` and `?weekKey=` |
| `GET /api/tormatch` | Direct TorMatch fetch; accepts `?id=` |
| `GET /api/sixeight` | Direct 6-8 Sports fetch; accepts `?leagueId=` |
| `GET /api/sheets` | Direct Sheets fetch |
| `GET /api/stats?game_id=N` | Per-game player stats |
| `GET /api/historical` | Season aggregates; accepts `?view=` and `?refresh=1` |
| `GET /api/niwp-weeks` | All available NIWP week keys for the chip selector |
| `GET /api/bracket` | Bracket structure (AES; unused for water polo) |
| `GET /api/snapshots` | List Vercel Blob snapshots |
| `GET /api/snapshot` | Read a specific snapshot |
| `GET /api/calendar.ics` | iCal feed |
| `POST /api/push-subscribe` | Register push subscription |

---

### Environment variables

| Variable | Project | Purpose |
|----------|---------|---------|
| `NIWP_API_ENABLED=true` | narwatch | Activate NIWP as primary source |
| `NIWP_TEAM_PREFIX=B` | narwatch | Squad filter (B \| G \| BJV \| GJV \| D) |
| `SIXEIGHT_ENABLED=true` | narwatch | Force 6-8 Sports on (skip auto-probe) |
| `SIXEIGHT_DISABLED=true` | narwatch | Force 6-8 Sports off |
| `SIXEIGHT_LEAGUE_ID=<uuid>` | narwatch | Pin JO league UUID; blank = auto-discover |
| `SIXEIGHT_TEAM_NAME=Narwhal` | narwatch | Team name fragment for filtering |
| `TORMATCH_TOURNAMENT_ID=<id>` | narwatch | Numeric ID from tormatch.com URL |
| `SPORTSENGINE_TOURNAMENT_ID=<hash>` | narwatch | `IDTournament=` param from tourneymachine.com |
| `SPORTSENGINE_TEAM_NAME=Narwhal` | narwatch | Team name fragment for SE |
| `GOOGLE_SHEETS_ID=<id>` | narwatch | Sheet ID from URL (see `docs/SHEETS_SETUP.md`) |
| `GOOGLE_SHEETS_API_KEY=<key>` | narwatch | Google Cloud API key, Sheets API scope |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | both | Web push (VAPID) |
| `VAPID_PRIVATE_KEY` | both | Web push (VAPID) |
| `VAPID_SUBJECT` | both | `mailto:...` for push contact |
| `BLOB_READ_WRITE_TOKEN` | both | Auto-injected by Vercel when Blob store is linked |

---

### Known gotchas

- **NIWP response envelope.** All three endpoints return `{success, data:[...]}`, not a plain array. Always unwrap: `Array.isArray(r) ? r : (r.data || [])`.
- **`game_date` timezone.** NIWP bare datetime strings are Pacific wall-clock with no offset. Never pass them to `new Date()` on the server — use `parseDateAsPT()`.
- **Stats field name.** It is `kickouts`, not `ejections` or `turnovers`.
- **TorMatch API key.** Reverse-engineered from the client bundle. May change; check `tormatch.js` if requests start 401-ing.
- **6-8 Sports league discovery.** `discoverLeague()` matches `name.includes("junior")`. If the JO league name changes upstream, update the probe.
- **NIWP opponent name variants.** The same team may appear with different spellings. Add new variants to `data/opponent_normalization_map.json` and re-run `compute-aggregates.js`.
- **Preview harness.** The Claude Preview tool does not reliably hydrate React for the large `pages/index.jsx`. Use `npm run build` for mechanical checks and claude-in-chrome against the live `narwatch.vercel.app` for DOM/LS/URL verification after deploy.
