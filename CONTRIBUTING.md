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
