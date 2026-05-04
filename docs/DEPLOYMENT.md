# Deployment Guide

---

## Vercel Project Setup

### App projects (serve the live apps)

| App | Vercel project | Project ID | rootDirectory | Canonical URL |
|-----|---------------|-----------|---------------|---------------|
| VolleyWatch | `volleywatch-app` | `prj_GaPD5q1DE04YcedAqq9kZyZcRSKH` | `apps/VolleyWatch` | volleywatch-app.vercel.app |
| NarWatch | `narwatch` | `prj_RTZprqmEXqD9DhmyrPOgR2e1P1ym` | `apps/NarWatch` | **narwatch.vercel.app** |

Both are git-connected to the SportTracker repo (team: `team_WrIwMG3myKXS5kxfk4uRMTvl`) and auto-deploy on push to `main`.

### Redirect-only projects

There is a separate project, `narwhaltracker` (`prj_MGvd4Z9B8T3jYAzTawFWBSnLKLNQ`), that exists solely to redirect old URLs. It has no rootDirectory, no framework, and serves a single `vercel.json` with permanent redirects to `narwatch.vercel.app`. **Never deploy app code to this project.**

| Old URL | Redirects to |
|---------|-------------|
| `narwhaltracker.vercel.app` | `narwatch.vercel.app` (308) |
| `narwhaltracker-gamma.vercel.app` | `narwatch.vercel.app` (308) |

In addition, the narwatch app's `next.config.js` contains a `redirects()` rule that catches all `narwatch-*.vercel.app` per-deployment hash URLs and 308s them to the canonical origin. So every possible non-canonical URL is covered at one layer or another.

### Critical: rootDirectory and the doubling trap

Vercel stores `rootDirectory` in the project settings (e.g. `apps/NarWatch`). When you run `vercel deploy`, it appends that value to whatever directory you're currently in. **If you run from inside `apps/NarWatch/`, Vercel combines the cwd with rootDirectory and looks for `apps/NarWatch/apps/NarWatch/` — which doesn't exist and the build fails with a path error.**

Always deploy from the **repo root** (`~/Developer/SportTracker`), not from inside an app directory.

---

## Standard Deployment

```bash
cd ~/Developer/SportTracker
git add -A
git commit -m "your message"
git push origin main
# Vercel auto-deploys both apps
```

That's it. Both Vercel projects are git-connected and deploy automatically on push to `main`.

---

## Manual Deploy Fallback

If git integration breaks or you need to force a specific app, use the `VERCEL_PROJECT_ID` env var override. This tells the Vercel CLI which project to target regardless of what `.vercel/project.json` says at the repo root. Always run from the repo root.

```bash
cd ~/Developer/SportTracker

# Deploy narwatch
VERCEL_PROJECT_ID=prj_RTZprqmEXqD9DhmyrPOgR2e1P1ym \
VERCEL_ORG_ID=team_WrIwMG3myKXS5kxfk4uRMTvl \
vercel deploy --prod --yes

# Deploy volleywatch
VERCEL_PROJECT_ID=prj_GaPD5q1DE04YcedAqq9kZyZcRSKH \
VERCEL_ORG_ID=team_WrIwMG3myKXS5kxfk4uRMTvl \
vercel deploy --prod --yes
```

The Vercel CLI auth token is stored at:
`~/Library/Application Support/com.vercel.cli/auth.json`

After a successful `--prod` deploy, the canonical URL (`narwatch.vercel.app` or `volleywatch-app.vercel.app`) is automatically aliased — you should see `Aliased: https://<canonical>` in the output. If you don't, run `vercel alias set <deployment-url> <canonical-url>` manually.

---

## Environment Variables

Set environment variables in the Vercel dashboard under each project's Settings → Environment Variables. The apps read them at build time (NEXT_PUBLIC_* prefix) or runtime (everything else).

### VolleyWatch — Required for Full Functionality

```
EVENT_ID              AES event ID for the current tournament season
DIVISION_ID           AES division ID
TEAM_ID               AES numeric team ID
TEAM_NAME             Display name (e.g., "208 U14 Red")
```

These have hardcoded defaults in `tournament.js`, so the app will run without them — but will point to whatever defaults were last baked in. Update these each season.

### VolleyWatch — Push Notifications (Optional)

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY    Generate with: npx web-push generate-vapid-keys --json
VAPID_PRIVATE_KEY
VAPID_SUBJECT                   mailto:you@example.com
BLOB_READ_WRITE_TOKEN           Auto-injected by Vercel when Blob store linked
```

To enable: link a Vercel Blob store to the `volleywatch` project (Storage tab in Vercel dashboard). The token is injected automatically.

### NarWatch — Data Source Toggle

Only one data source is active at a time (first match in the priority chain wins). Set the appropriate env var for the current tournament:

```bash
# For NIWP club tournaments (usual season default):
NIWP_API_ENABLED=true
NIWP_TEAM_PREFIX=B   # or G, BJV, GJV

# For USAWP Junior Olympics (auto-detected; no vars needed):
# (leave SIXEIGHT_ENABLED blank and auto-probe handles it)

# For TorMatch tournament:
TORMATCH_TOURNAMENT_ID=258   # numeric ID from tormatch.com URL

# For Google Sheets fallback:
GOOGLE_SHEETS_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
GOOGLE_SHEETS_API_KEY=AIza...
```

---

## How to Add a New Tournament

### VolleyWatch (AES tournament)

1. Open `apps/VolleyWatch/.env.local` (local) or Vercel env vars (production).
2. Update `EVENT_ID`, `DIVISION_ID`, and optionally `TEAM_ID`.
3. To find the IDs: open the AES results page for the tournament, open DevTools Network tab, and read the IDs from any API request URL.
4. Redeploy (or push to trigger auto-deploy).

### NarWatch (NIWP weekly tournament)

No action needed. NIWP events are detected automatically by week. The `?weekKey=YYYY-Www` parameter in `/api/niwp` selects a specific week; the default is the most recent week with games.

### NarWatch (TorMatch tournament)

1. Find the tournament on tormatch.com and read the numeric ID from the URL.
2. Set `TORMATCH_TOURNAMENT_ID=<id>` in the narwatch Vercel project env vars.
3. Unset `NIWP_API_ENABLED` (or set to blank/false) so TorMatch takes priority.
4. Redeploy.

### NarWatch (JO on 6-8 Sports)

Auto-detects. No env vars needed. If it doesn't auto-detect:
- `SIXEIGHT_ENABLED=true` forces it on.
- `SIXEIGHT_LEAGUE_ID=<uuid>` pins the specific league if auto-discovery fails.

---

## URL Redirect Architecture

All non-canonical URLs redirect permanently (308) to the canonical URL. There is no dead end — every old bookmark routes to the right place automatically.

### NarWatch

| URL | Handled by | Destination |
|-----|-----------|-------------|
| `narwhaltracker.vercel.app` | `narwhaltracker` Vercel project (redirect payload) | `narwatch.vercel.app` |
| `narwhaltracker-gamma.vercel.app` | same | `narwatch.vercel.app` |
| `narwatch-[hash]-lswingrovers-projects.vercel.app` | `next.config.js` redirects() | `narwatch.vercel.app` |

### VolleyWatch

| URL | Handled by | Destination |
|-----|-----------|-------------|
| `208tracker.vercel.app` | `next.config.js` redirects() | `volleywatch-app.vercel.app` |
| `volleywatch-[hash]-lswingrovers-projects.vercel.app` | `next.config.js` redirects() | `volleywatch-app.vercel.app` |

---

## Vercel Blob Setup (Push Notifications)

1. In the Vercel dashboard, go to the project (volleywatch or narwatch).
2. Storage tab → Create new Blob store, or connect an existing one.
3. The `BLOB_READ_WRITE_TOKEN` env var is injected automatically.
4. Generate VAPID keys: `npx web-push generate-vapid-keys --json`
5. Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in the project's env vars.
6. Redeploy.

Both apps can share the same Blob store — state keys are namespaced by `teamId`.

---

## Troubleshooting

### Build fails with "cannot find module @sport-tracker/core"

The workspace package isn't being resolved. Check that `next.config.js` has `transpilePackages: ['@sport-tracker/core']`. Also verify that `packages/core/package.json` has `"name": "@sport-tracker/core"`.

### Vercel error: "The provided path .../apps/NarWatch/apps/NarWatch does not exist"

You ran `vercel deploy` from inside `apps/NarWatch/` (or `apps/VolleyWatch/`). Vercel appends its stored `rootDirectory` to your current working directory, so running from inside the app dir doubles the path. Always run from the **repo root** (`~/Developer/SportTracker`) using the `VERCEL_PROJECT_ID` override — see Manual Deploy Fallback above.

### AES data not updating

Check the `cached` field in the API response. If `cached: true`, the module-level cache is serving. Add `?force=1` to bypass. If still stale, check that the `timestamp` endpoint is reachable: `https://results.advancedeventsystems.com/api/event/{eventId}/timestamp`.

### NaN showing in standings

AES returns the string `"NaN"` for `SetPercent` when a team has played zero sets. The normalizer handles this with `parseFloat(r.SetPercent ?? 0) || 0`. If you see NaN in the UI, check that the normalizer is being applied.

### PWA icon not updating after deploy

Browsers aggressively cache PWA icons. After updating icons:
1. Bump the service worker version (or any change to `sw.js`) to force SW refresh.
2. On Android Chrome: Settings → Apps → VolleyWatch/NarWatch → Clear cache.
3. Alternatively, change the icon filename (requires manifest.json update).

### NIWP times are off by 7-8 hours

The `game_date` field is bare Pacific wall-clock time. It must be parsed with `parseDateAsPT()` in `niwp.js`, not with `new Date(dateStr)` directly. If you add a new script that processes NIWP dates, import `parseDateAsPT` from `niwp.js` or replicate the logic.

### Push notifications not delivering

1. Verify `BLOB_READ_WRITE_TOKEN` is set (check Vercel Storage tab).
2. Verify VAPID keys are set and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` matches what the browser subscribed with.
3. Push subscriptions are keyed to a specific VAPID public key — if you rotate keys, all existing subscribers must re-subscribe.
4. Check the Vercel function logs for `[diffAndPush]` errors.

### TorMatch data not loading

The API key is baked in but is reverse-engineered. If TorMatch changes their key, update `getApiKey()` in `tormatch.js`. The `Promise.allSettled` approach means partial failures are silent — check which fields are null in the response to identify which endpoint failed.
