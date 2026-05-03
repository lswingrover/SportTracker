# Deployment Guide

---

## Vercel Project Setup

There are two Vercel projects, one per app. Both are connected to the same GitHub repository (`sport-tracker`) with different `rootDirectory` settings.

| App | Vercel project | rootDirectory | URL |
|-----|---------------|---------------|-----|
| VolleyWatch | `volleywatch` | `apps/volleywatch` | volleywatch-app.vercel.app |
| NarWatch | `narwatch` | `apps/narwatch` | narwhaltracker.vercel.app |

### Critical: rootDirectory

Vercel evaluates `rootDirectory` relative to the repo root. **Never run `vercel --prod` from inside `apps/narwatch/` or `apps/volleywatch/`** — the path doubles and the build fails. Always deploy from the repo root, or rely on git-triggered builds.

---

## Standard Deployment

```bash
cd ~/Developer/sport-tracker
git add -A
git commit -m "your message"
git push origin main
# Vercel auto-deploys both apps
```

That's it. Both Vercel projects are git-connected and deploy automatically on push to `main`.

---

## Manual Deploy Fallback

If git integration breaks or you need to force a specific app:

```bash
cd ~/Developer/sport-tracker

# Deploy narwatch
cp .vercel/project.json .vercel/project.json.bak
cp apps/narwatch/.vercel/project.json .vercel/project.json
vercel --prod
mv .vercel/project.json.bak .vercel/project.json

# Deploy volleywatch
cp .vercel/project.json .vercel/project.json.bak
cp apps/volleywatch/.vercel/project.json .vercel/project.json
vercel --prod
mv .vercel/project.json.bak .vercel/project.json
```

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

1. Open `apps/volleywatch/.env.local` (local) or Vercel env vars (production).
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

## Old URL Redirects

The apps were previously deployed under different names:

| Old URL | New URL |
|---------|---------|
| `208tracker.vercel.app` | `volleywatch-app.vercel.app` |
| `narwhaltracker.vercel.app` | *(same — narwatch project retained this URL)* |

There is no automated redirect from the old URL. Users who bookmarked the old URL need to update manually.

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

### Vercel rootDirectory error ("Could not find Next.js config")

You're likely running `vercel --prod` from inside the wrong directory, or the `rootDirectory` is set incorrectly in the Vercel project settings. The value should be `apps/volleywatch` or `apps/narwatch` — relative to the repo root, without a leading slash.

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
