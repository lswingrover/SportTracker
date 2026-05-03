# Sport-Tracker Monorepo — Working Notes

> Living doc. Updated by Claude at the end of any session that changes
> the codebase or deployment. Not a spec — a record of what we know,
> what we decided, and what to do next.

---

## Current State (2026-05-02, updated 19:45)

### What's deployed and where

| App | Vercel Project | URL | Git-connected? |
|-----|---------------|-----|---------------|
| narwhaltracker | `narwatch` (`prj_RTZprqmEXqD9DhmyrPOgR2e1P1ym`) | narwhaltracker.vercel.app | **Yes** ✓ (wired 2026-05-02) |
| 208tracker | `volleywatch-app` (git-connected, rootDirectory fixed) | check Vercel dashboard | **Yes** ✓ (rootDir fixed 2026-05-02) |
| monorepo root | `sport-tracker` (`prj_rdepbE14qRVfGvZoxaogBVt4RUdR`) | sport-tracker-rust.vercel.app | unknown |

### Data source status

| App | Active source | Toggle |
|-----|--------------|--------|
| narwhaltracker | NIWP WordPress API | `NIWP_API_ENABLED=true` in narwatch Vercel project |
| 208tracker | AES scraper | n/a |

### NarWatch data source priority chain (as of commit e8f1614)

```
1. NIWP WordPress API     — NIWP_API_ENABLED=true       (active default)
2. 6-8 Sports             — SIXEIGHT_ENABLED=true        (JOs only)
3. TorMatch               — TORMATCH_TOURNAMENT_ID=<id>  (platform tournaments)
4. SportsEngine Tourney   — SPORTSENGINE_TOURNAMENT_ID=<hash>
5. Google Sheets          — GOOGLE_SHEETS_ID=<id>        (manual fallback)
6. Static                 — tournamentData.js             (last resort)
```

Each branch is mutually exclusive (first match wins). To switch sources for
a tournament, set the appropriate env var in the narwatch Vercel project and
redeploy.

### Shared package (`packages/core`)

Used by both apps for: push subscriptions, blob storage, snapshots, state diffing,
standings derivation (`gameNorm.js` — added 2026-05-02).
Not yet consolidated: data-fetching logic, game normalization (source-specific
parsing still lives in each adapter — niwp.js, sheets.js, tournament.js).

---

## Deployment Protocol

**The correct way to deploy narwhaltracker** (`git push origin main` now triggers it automatically):

```bash
cd ~/Developer/sport-tracker
git add -A && git commit -m "your message"
git push origin main
# Vercel auto-deploys narwatch from apps/narwhaltracker
# Vercel auto-deploys volleywatch-app from apps/volleywatch
```

**Manual deploy fallback** (if git integration breaks or you need to force):

```bash
cd ~/Developer/sport-tracker

# 1. Swap root project.json to narwatch
cp .vercel/project.json .vercel/project.json.bak
cp apps/narwhaltracker/.vercel/project.json .vercel/project.json

# 2. Deploy
vercel --prod

# 3. Restore
mv .vercel/project.json.bak .vercel/project.json
```

**Never** run `vercel --prod` from inside `apps/narwhaltracker/` — Vercel's
rootDirectory setting (`apps/narwhaltracker`) is relative to the repo root,
so running from inside that dir doubles the path and errors out.

**Git commits** cannot be written from the sandbox (permission error on
`.git/objects`). Use Terminal via osascript `do shell script` or open a
real terminal. The sandbox `git add` works fine; only `git commit` fails.

---

## Lessons Learned

### NIWP API (2026-05-02)

- Endpoint: `https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1/`
- **Response envelope**: all three endpoints (`/games`, `/players`,
  `/games/{id}/stats`) return `{"success": true, "data": [...]}`, not a
  plain array. Always unwrap: `Array.isArray(r) ? r : (r.data || [])`.
- Teams named `CDA 18U Boys`, `CDA 14U Co-Ed`, etc. — detect by "cda"
  substring (case-insensitive). Current Boys Varsity games use game IDs
  in the 130s (as of May 2026).
- Stats field `kickouts` (not `ejections`, not `turnovers`).
- No auth needed. No rate limit documented. Server-side 60s cache means
  at most 2 req/min to the NIWP server regardless of NarWatch user count.

### Vercel / deployment (updated 2026-05-02)

- **narwatch is now git-connected** to `lswingrover/sport-tracker` via the
  Vercel API (`POST /v9/projects/{id}/link`). repoId=1223949946,
  gitCredentialId=`cred_c569f8a164f20bea332b9c139a1196e8f080bde9`.
  Verified: push d910e8a triggered dpl_8MBqP3UsxHoe1MR4a6oJVXr8Bemb (READY).
- **volleywatch-app rootDirectory** was `null`, causing every push to fail
  in ~3s. Fixed to `apps/volleywatch` via `PATCH /v9/projects/volleywatch-app`.
  Verified: next push built READY (dpl_fBDWiL3KNLipd1RCzNh88wjSZqcQ).
- **208tracker project** (old dead project) is separate from volleywatch-app
  — ignore it. The live 208tracker app is `volleywatch-app`.
- `vercel redeploy <url>` re-runs the old build — it does NOT pick up new
  code or new env vars at runtime. Always do a fresh `vercel --prod`.
- Env vars set via `vercel env add` take effect on the *next* fresh deploy,
  not on a redeploy.
- `vercel env ls --cwd <app-dir>` correctly identifies which project you're
  in and lists its vars.
- **Vercel API token creation**: `vercel tokens create` requires a classic
  PAT scope and fails for OAuth sessions. Instead: go to
  vercel.com/account/tokens → create token with "lswingrover's projects"
  scope → use in curl with `Authorization: Bearer <token>`.
- **Git lock files**: sandbox Claude Code sessions can leave `.git/*.lock`
  files that block commits. Fix: `find .git -name '*.lock' -exec rm {} \;`

### Render-guard symmetry (2026-05-02)

Any conditional logic in `load()` that bypasses the static bail also needs
a matching guard in the JSX render. These two sites must always stay in sync:

```js
// load() — don't bail when in NIWP mode
if (tournament.static && !niwpWeeks) { ... return; }

// JSX render — same condition
{tournament.static && !niwpWeeks ? <StaticTournamentCard /> : <live content>}
```

The original bug: we fixed `load()` but left the render unconditionally
checking `tournament.static`. Data loaded fine (network tab confirmed),
chips rendered fine, but the content area stayed frozen on the placeholder.
Pattern: whenever a `load()` guard changes, grep the JSX for the same
condition and update it too.

### iOS PWA service worker (2026-05-02)

Both apps need the network-first fetch handler in their SW. Without it, iOS
caches the app shell at the OS level and never picks up new bundles after
Vercel deploys. Standard template for any new app:

```js
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
  }
});
```

`skipWaiting` + `clients.claim` alone are NOT enough on iOS — the fetch
interception is required. Applied to narwhaltracker (b91eb26 predecessor)
and 208tracker (67c9aca).

### 6-8 Sports API (2026-05-02, session 2)

- Base URL: `https://api.6-8sports.com/api` — undocumented, reverse-engineered
  from the Angular bundle on 6-8sports.com. No auth required. CORS `*`.
- **Official USAWP JO stats provider** — this is the authoritative live source
  for Junior Olympics. Updated by Ryan Curry (stat crew) in real time during
  play.
- Key endpoints:
  - `GET /v2/leagues/links/` → array of `{pk, name}` league records. Used for
    JO league auto-discovery (look for "Junior Olympics" substring in name).
  - `GET /v2/leagues/{id}/games/?page=1&pageSize=50` → paginated game list.
    Each game has `in_progress: bool` for live detection.
  - `GET /v2/games/{id}/` → full detail including `live_score_data`, periods,
    play-by-play events.
- **League ID auto-discovery**: if `SIXEIGHT_LEAGUE_ID` is blank, `sixeight.js`
  calls `/v2/leagues/links/` and finds the first entry matching "junior ol".
  Caches result for the session. You can pin a league ID in the env var to skip
  discovery.
- Known JO league IDs: 2024 JOs = `cd6b2b16-...` (verify at runtime — IDs
  rotate each season; use auto-discovery).
- **Toggle**: No longer needed. 6-8 Sports auto-detects JO season (commit 63aa19c).
  `probeNarwhalsGames()` exported from sixeight.js; called in tournament.js before
  the NIWP branch. Activates when any Narwhal game is in_progress or scheduled
  today. Negative cache: 10 min. Positive cache: 2 min.
  Override: `SIXEIGHT_ENABLED=true` (force) / `SIXEIGHT_DISABLED=true` (suppress).
- **Team filter**: `SIXEIGHT_TEAM_NAME=Narwhal` (default) — matched as
  case-insensitive substring against home/away team names.

### SportsEngine TourneyMachine scraper (2026-05-02, session 2)

- URL pattern: `https://tourneymachine.com/Public/Results/Tournament.aspx?IDTournament=<hash>`
- Server-rendered HTML, no auth, no API. Scrapable with cheerio.
- **Division pages**: the main tournament page lists divisions with hrefs like
  `Schedule.aspx?IDTournament=<hash>&IDDivision=<id>`. Scraper fetches each.
- **Date parsing**: schedule tables have date-header rows (class `tableAlternate`)
  that set the running date for subsequent game rows. Game rows have 7 cells:
  time | game# | home | away | homeScore | awayScore | location.
- **Status detection**: both scores present + non-null → `done`. No in-progress
  flag available (SportsEngine doesn't expose live state via HTML).
- **Tournament ID discovery**: Google `site:tourneymachine.com "Tournament Name"`
  → click the result → extract `IDTournament=` param from URL.
- **Toggle**: `SPORTSENGINE_TOURNAMENT_ID=<hash>` in narwatch Vercel project.
- **Team filter**: `SPORTSENGINE_TEAM_NAME=Narwhal` (default).
- **Cheerio dep**: added to `apps/narwhaltracker` package.json in commit e8f1614.

### Orphan repo cleanup (2026-05-02, session 2)

A standalone `narwatch-api` TypeScript backend was created during exploration
(full poller, registry, SSE server) before we discovered sport-tracker existed.
All useful work (sixeight.js, sportsengine.js adapters) was migrated into
sport-tracker and the orphan was deleted from GitHub (DELETE /repos/lswingrover/narwatch-api → 204).

The TypeScript types and polling architecture from narwatch-api are documented
in `~/Documents/Claude/NarWatch/data-sources.md` for reference if we ever
want to build a standalone poller service.

### Exposure Events API (2026-05-02, session 2)

- API requires a **director account** — parent-level accounts don't get API keys.
- Registration URL: `https://waterpolo.exposureevents.com/register` (free, self-serve)
- **Email sent to apps@exposureevents.com** on 2026-05-02 requesting API access.
- Awaiting response. If API access comes through, adapter goes in as a new
  branch in `tournament.js` (add between TorMatch and SportsEngine, or after
  NIWP depending on which tournament it's needed for).
- The WAF at exposureevents.com blocks unauthenticated server-side requests —
  a browser fetch works but curl/Node fails with connection reset. Once we have
  a valid API key this shouldn't matter.

### Next.js + monorepo

- Both apps have `transpilePackages: ['@sport-tracker/core']` in
  `next.config.js`. This is required for the workspace package to build
  correctly under Next.js.
- The root `package.json` has workspaces: `["packages/*", "apps/*"]`.
  `npm install` at the root hoists deps and links workspace packages.

---

## Next Steps (priority order)

### 1. Trident Cup — confirm platform and get SportsEngine ID

The Trident Cup (Team Orlando) registration is on Squarespace, but the bracket/
schedule may be on TorMatch OR tourneymachine.com — unclear which.

**Action**: When Team Orlando publishes the bracket (usually 1–2 weeks before
the tournament), check whether the URL is:
- `tormatch.com/tournament/...` → set `TORMATCH_TOURNAMENT_ID` in narwatch Vercel
- `tourneymachine.com/...` → extract `IDTournament=` hash, set `SPORTSENGINE_TOURNAMENT_ID`

If TorMatch, the existing `tormatch.js` adapter handles it — just set the env var.
(Note: existing tormatch.js has tournament ID 258 hardcoded as a fallback — 
verify whether 258 is a current Trident Cup ID or stale.)

### 2. Exposure Events API access

Email sent 2026-05-02 to apps@exposureevents.com. Also: Louis should manually
register a free director account at `https://waterpolo.exposureevents.com/register`
to test whether a self-registered key can read other directors' event data
(i.e., Altitude Classic). If access confirmed: build exposureevents.js adapter
and wire into tournament.js priority chain.

### ~~3. JO prep — manual toggle~~ ✓ ELIMINATED (2026-05-02, commit 63aa19c)

6-8 Sports now auto-detects JO season. `probeNarwhalsGames()` fires on every
request, checks for in_progress or today-scheduled Narwhal games, and routes
to the 6-8 Sports handler automatically. 10min negative cache = zero overhead
outside JO season. 2min positive cache during JOs for fast live updates.

One remaining action: before July, smoke-test in a Vercel preview with
`SIXEIGHT_ENABLED=true` to confirm 2026 league ID is discoverable.
Escape hatches: `SIXEIGHT_DISABLED=true` (suppress), `SIXEIGHT_ENABLED=true` (force).

### ~~1. Wire Vercel git integration~~ ✓ DONE (2026-05-02)
narwatch and volleywatch-app both now auto-deploy on `git push origin main`.

### ~~2. Audit 208tracker deployment~~ ✓ DONE (2026-05-02)
208tracker live app = volleywatch-app (rootDirectory now fixed to apps/volleywatch).

---

### ~~1. Consolidate shared logic into `packages/core`~~ ✓ DONE (2026-05-02)
`deriveStandings` extracted to `packages/core/gameNorm.js` (commit e8add64).
Both `niwp.js` and `sheets.js` now import from core. The 208tracker uses
`normalizeStandings` (AES-specific) so it was not part of this change —
the output shapes remain compatible. No behaviour change.

---

### ~~3. NarWatch: render guard bug~~ ✓ DONE (2026-05-02, commit b91eb26)
The JSX render had the same `tournament.static` check as the `load()` bail
we fixed earlier — but in the return JSX, not the function body.

```jsx
// BEFORE (bug):
{tournament.static ? <StaticTournamentCard /> : <live content>}

// AFTER (fix):
{tournament.static && !niwpWeeks ? <StaticTournamentCard /> : <live content>}
```

Effect: NIWP data was loading (network tab showed successful API calls,
chip row rendered correctly), but the page always showed the static Bend
placeholder card because the render condition never checked whether
`niwpWeeks` was available. One character change, same `&& !niwpWeeks`
guard pattern as the `load()` fix.

---

### ~~2. NarWatch: multi-week tournament support~~ ✓ DONE (2026-05-02)
Commit `15da052`. Three changes:

1. `/api/niwp-weeks` (new) — fetches all NIWP games, groups by ISO week,
   returns `[{weekKey, chipLabel, label, startDate, endDate, location}]`.
   Returns `[]` when `NIWP_API_ENABLED` is not set (safe no-op for non-NIWP).

2. `niwp.js` — `?weekKey=YYYY-Www` param: serves specified week or falls
   back to most recent. Cache keyed by `teamPrefix:weekKey` so weeks are
   cached independently.

3. `index.jsx` — fetches `/api/niwp-weeks` on mount. When weeks are
   present, chip row renders one chip per NIWP week (oldest→newest).
   **Also fixed a latent bug**: the static-tournament early-return in
   `load()` was silently preventing any API call when the placeholder
   tournament had `static:true` — meaning NIWP data NEVER actually loaded
   in production despite `NIWP_API_ENABLED=true`. Now bypassed in NIWP mode.

---

## Self-Management Rules

1. **Update this file at the end of every session** that touches code or
   deployment. Specifically: what changed, what was learned, what broke
   and why, what's next.

2. **Never deploy without a commit first.** Even a one-line fix gets a
   commit message. This file + git log = full project history.

3. **Test the live endpoint after every deploy** before declaring done.
   Minimum check: `curl /api/tournament` and confirm `_dataSource` and
   `games` count look right.

4. **One thing at a time.** Don't refactor shared logic and change the
   deployment setup in the same session. Blast radius compounds.

5. **When something weird happens, write it down here before fixing it.**
   The fix is obvious in the moment; the cause is not obvious two weeks later.

6. **Env vars are infrastructure.** Document every env var that's added
   (what it does, which Vercel project it's on, when it was set) in this
   file and in `.env.example`.

---

## Env Var Registry

| Var | Value | Project | Set | Purpose |
|-----|-------|---------|-----|---------|
| `NIWP_API_ENABLED` | `true` | narwatch | 2026-05-02 | Activates NIWP WordPress API as primary data source |
| `NIWP_TEAM_PREFIX` | `B` | narwatch | 2026-05-02 | Default squad filter (B=Boys Varsity) |
| `GOOGLE_SHEETS_ID` | (not set) | narwatch | — | Would enable Sheets fallback |
| `GOOGLE_SHEETS_API_KEY` | (not set) | narwatch | — | Required with SHEETS_ID |
| `BLOB_READ_WRITE_TOKEN` | auto-injected | both | — | Vercel Blob, linked store |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | set | both | prior | Web push |
| `VAPID_PRIVATE_KEY` | set | both | prior | Web push |
| `SIXEIGHT_ENABLED` | (not set) | narwatch | — | Set to `true` during JOs to use 6-8 Sports API |
| `SIXEIGHT_LEAGUE_ID` | (not set) | narwatch | — | Optional: pin JO league UUID; blank = auto-discover |
| `SIXEIGHT_TEAM_NAME` | (not set, defaults to "Narwhal") | narwatch | — | Team name fragment for filtering |
| `TORMATCH_TOURNAMENT_ID` | (not set) | narwatch | — | Set to numeric tournament ID when on TorMatch |
| `SPORTSENGINE_TOURNAMENT_ID` | (not set) | narwatch | — | Set to tourneymachine.com hash ID for SE tournaments |
| `SPORTSENGINE_TEAM_NAME` | (not set, defaults to "Narwhal") | narwatch | — | Team name fragment for SE filtering |
