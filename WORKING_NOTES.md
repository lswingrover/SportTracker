# Sport-Tracker Monorepo — Working Notes

> Living doc. Updated by Claude at the end of any session that changes
> the codebase or deployment. Not a spec — a record of what we know,
> what we decided, and what to do next.

---

## Current State (2026-05-02, updated 18:50)

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

### Shared package (`packages/core`)

Used by both apps for: push subscriptions, blob storage, snapshots, state diffing.
Not yet used for: data-fetching logic, standings derivation, game normalization
(those are still duplicated between the two apps).

---

## Deployment Protocol

**The correct way to deploy narwhaltracker** (`git push origin main` now triggers it automatically):

```bash
cd ~/Developer/sport-tracker
git add -A && git commit -m "your message"
git push origin main
# Vercel auto-deploys narwatch from apps/narwhaltracker
# Vercel auto-deploys volleywatch-app from apps/208tracker
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
  in ~3s. Fixed to `apps/208tracker` via `PATCH /v9/projects/volleywatch-app`.
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

### Next.js + monorepo

- Both apps have `transpilePackages: ['@sport-tracker/core']` in
  `next.config.js`. This is required for the workspace package to build
  correctly under Next.js.
- The root `package.json` has workspaces: `["packages/*", "apps/*"]`.
  `npm install` at the root hoists deps and links workspace packages.

---

## Next Steps (priority order)

### ~~1. Wire Vercel git integration~~ ✓ DONE (2026-05-02)
narwatch and volleywatch-app both now auto-deploy on `git push origin main`.

### ~~2. Audit 208tracker deployment~~ ✓ DONE (2026-05-02)
208tracker live app = volleywatch-app (rootDirectory now fixed to apps/208tracker).

---

### 1. Consolidate shared logic into `packages/core`
**What:** Game normalization (W/L derivation, score parsing, standings
derivation) is duplicated between `sheets.js`, `niwp.js`, and the
208tracker equivalent. Move to `packages/core/gameNorm.js`.

**Risk:** Medium. Both apps depend on the normalized game shape — any
change to field names breaks the frontend. Do this with a side-by-side
diff before touching either app.

**When:** Now safe — git integration is wired. Mistakes are recoverable via revert.

---

### 2. NarWatch: multi-week tournament support
**What:** `niwp.js` currently returns only the most recent calendar week.
Multiple weeks = multiple tournaments. The frontend chip row should show
one chip per week.

**Complexity:** Requires a change to how `TOURNAMENTS` is populated —
currently static in `lib/tournamentData.js`. Either make it dynamic
(fetch from NIWP on app load) or generate it at build time.

**Deferred until:** NIWP has multi-week data to test against.

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
