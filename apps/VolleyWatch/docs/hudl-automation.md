# Hudl Broadcast Automation

Documents the automated pipeline for keeping `hudl-broadcasts.js` up to date without manual intervention.

## What it does

A Cowork scheduled task (`hudl-broadcast-sync`) runs nightly at 10 PM. It:

1. Loads the [208 VBC U14 RED Hudl Fan page](https://fan.hudl.com/usa/id/post-falls/organization/192465/208-volleyball/team/921788/u14-red) via Chrome in a headless session (the page is React-rendered and requires JavaScript)
2. Extracts all broadcast IDs using a DOM query against `a[href*="/watch?b="]`
3. Diffs against `HUDL_BROADCASTS` in `lib/hudl-broadcasts.js`
4. For each new broadcast, queries Fantastical for volleyball-tagged calendar events in the past 21 days to derive the tournament name, date(s), and timezone
5. Auto-generates both the `HUDL_BROADCASTS` entry and — if it's a new tournament — the `TOURNAMENT_WINDOWS` entry
6. Commits and pushes to `main`

No manual edits to `hudl-broadcasts.js` are ever required.

## Why Chrome MCP instead of a plain HTTP fetch

The Hudl Fan team page is a React SPA. A raw `fetch()` of the URL returns only the initial HTML shell with no broadcast links — the link elements are injected by JavaScript at runtime. The automation uses Claude in Chrome (a browser extension MCP) to navigate to the page, wait for it to render, and then run a `document.querySelectorAll` extraction. This is the only reliable way to get the broadcast list.

## Tournament metadata resolution

The task has no hardcoded list of future tournaments. Instead it:

- Queries Fantastical (the calendar app) for events in the past 21 days whose titles contain keywords like "208", "VBC", "Volleyball", "Fest", "Regional", "Jamboree", etc.
- Strips athlete/org prefixes ("Bella –", "208 VBC:") from the title to get a clean tournament name
- Converts the name to a kebab-case slug (e.g. `big-sky-volleyfest-2026`)
- Infers the timezone from the event location (Montana/Wyoming → `America/Denver`; Idaho/Washington → `America/Los_Angeles`)
- Derives the `dates` array for `TOURNAMENT_WINDOWS` from the calendar event's start–end span

This means adding a new tournament to the system requires only putting it on the calendar — nothing in the codebase needs to change.

## Broadcast ID format

Hudl encodes broadcast IDs as base64 in the `?b=` URL parameter (sometimes URL-encoded on top of that). The automation URL-decodes first, then stores the base64 string directly.

Example: `QnJvYWRjYXN0NDAwNjAxMA%3D%3D` → `QnJvYWRjYXN0NDAwNjAxMA==` → stored as-is.

The watch URL is reconstructed at runtime in `findBroadcast()` as:
```
https://www.hudl.com/team/v2/921788/fan/watch?b=<encodeURIComponent(broadcastId)>
```

## Scheduled task location

The task prompt lives in:
```
~/Library/Mobile Documents/com~apple~CloudDocs/Claude/Scheduled/hudl-broadcast-sync/SKILL.md
```

A copy is preserved here in the repo for reference:
```
apps/volleywatch/docs/hudl-broadcast-sync-task.md
```

## Season status

**2025-26 season complete.** The `hudl-broadcast-sync` task exists in the scheduler but is disabled off-season. Re-enable at the start of the next season (task ID: `hudl-broadcast-sync`). The old one-off task (`hudl-bhj-broadcast-poller`) was the predecessor and is also disabled — it can be deleted.
