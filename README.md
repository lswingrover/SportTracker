# SportTracker

Two tournament-tracker PWAs sharing a core engine, built for one specific family of fans (Soren plays water polo, Bella plays volleyball) and gradually generalized as needs evolve.

| App | Path | Deploy | Sport / Team |
|-----|------|--------|--------------|
| **NarWatch** | [`apps/NarWatch`](apps/NarWatch) | [narwatch.vercel.app](https://narwatch.vercel.app) | Water polo — North Idaho Narwhals |
| **VolleyWatch** | [`apps/VolleyWatch`](apps/VolleyWatch) | [volleywatch-app.vercel.app](https://volleywatch-app.vercel.app) | Volleyball — 208 U14 Red |

Both use the **Next.js pages router**, share workspace packages in [`packages/`](packages), and auto-deploy from `main` via Vercel. The shared `packages/core` carries the state-diff engine, push-notification dedupe, blob store, and snapshots; each app supplies its own data adapters for whatever upstream API the sport happens to use (NIWP WordPress, 6-8 Sports, TorMatch, SportsEngine, AES, Google Sheets, or static JSON).

## Quick start

```bash
git clone https://github.com/lswingrover/SportTracker.git
cd SportTracker
npm install
npm --prefix apps/NarWatch run dev      # http://localhost:3000
# or
npm --prefix apps/VolleyWatch run dev   # http://localhost:3000
```

Live data sources are env-var-gated and default to static fallbacks — see each app's `pages/api/tournament.js` header for the priority order (`NIWP_API_ENABLED`, `SIXEIGHT_ENABLED`, `TORMATCH_TOURNAMENT_ID`, `SPORTSENGINE_TOURNAMENT_ID`, `GOOGLE_SHEETS_ID`, etc.).

## Docs

- [**CONTRIBUTING.md**](CONTRIBUTING.md) — branch naming, Conventional Commits, PR body convention, label taxonomy
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — monorepo layout, shared core, app boundaries
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) — every upstream API and how it's adapted
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — two-project Vercel architecture, canonical URLs

## Project conventions

This repo deploys to production on every merge to `main`. Workflow:

1. File an issue describing the symptom, audit, and fix approach (see [issue #1](https://github.com/lswingrover/SportTracker/issues/1) as a worked example).
2. Branch as `type/short-kebab-description` (`perf/...`, `fix/...`, `feat/...`).
3. Commit in Conventional Commits style: `type(scope): subject`.
4. Open a PR with Summary / What changed / Risk / Test plan. Link the issue with `Closes #N`.
5. Squash-merge default. CI must be green.

If you're an AI agent picking up work here cold: read CONTRIBUTING.md first, then check open issues for active scope, then verify CI is green before pushing anything.

## License

Personal project. No license declared — all rights reserved by the author.
