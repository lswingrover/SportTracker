## Hudl Broadcast Auto-Sync

Fully automated. Fetches the 208 VBC U14 RED Hudl Fan page, finds any broadcasts not yet in hudl-broadcasts.js, resolves all metadata (opponent, date, tournament slug, timezone) from the Fantastical calendar, writes both HUDL_BROADCASTS and TOURNAMENT_WINDOWS entries, commits, and pushes. No human input required at any point.

---

### Step 1 — Fetch Hudl Fan page via Chrome MCP

Load ToolSearch schemas: mcp__Claude_in_Chrome__tabs_context_mcp, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__javascript_tool

Open a new MCP tab and navigate to:
  https://fan.hudl.com/usa/id/post-falls/organization/192465/208-volleyball/team/921788/u14-red

Wait 4 seconds for the React app to render. Then run this JS to extract all broadcasts:

```js
[...document.querySelectorAll('a[href*="/watch?b="]')]
  .map(a => ({ href: a.href, text: a.innerText?.trim().replace(/\s+/g, ' ') }))
```

URL-decode the `?b=` parameter from each href to get the broadcastId:
  e.g. `QnJvYWRjYXN0NDAwNjAxMA%3D%3D` → `QnJvYWRjYXN0NDAwNjAxMA==`

Deduplicate by broadcastId.

Also run this JS to get any richer card context (dates, tournament labels visible on the page):

```js
[...document.querySelectorAll('a[href*="/watch?b="]')].map(a => {
  const card = a.closest('article, li, [class*="card"], [class*="Card"], [class*="event"]') || a.parentElement?.parentElement;
  return { href: a.href, cardText: card?.innerText?.trim().replace(/\s+/g, ' ')?.substring(0, 400) };
})
```

Record the full `cardText` for each broadcast — it may contain a date or tournament name.

---

### Step 2 — Read current hudl-broadcasts.js

Read: /Users/louisswingrover/Developer/sport-tracker/apps/volleywatch/lib/hudl-broadcasts.js

Parse out all existing `broadcastId` values in HUDL_BROADCASTS.
Parse out all existing `slug` values in TOURNAMENT_WINDOWS.

---

### Step 3 — Diff

Compare broadcastIds from Step 1 vs existing. Identify new ones.

If zero new broadcasts: log "No new broadcasts — nothing to do." and exit.

---

### Step 4 — Resolve metadata for each new broadcast

For each new broadcast:

**4a — Opponent name**
From link text like "U14 RED vs. BHJ 14-Green": strip the "U14 RED vs. " prefix (case-insensitive) and trim.

**4b — Date and tournament via Fantastical**
Load ToolSearch schemas: mcp__Fantastical__queryCalendarItems, mcp__Fantastical__queryCalendars

Query all calendars for events in the past 21 days. Filter for events whose title contains any of (case-insensitive): "208", "VBC", "volleyball", "Volley", "Regional", "Jamboree", "Showdown", "Showcase", "Power League", "Fest", "tournament", "Bella".

For each matching event extract:
- eventDate: start date as YYYY-MM-DD
- allDates: if multi-day event, array of YYYY-MM-DD for each day in range
- rawTitle: full event title
- location: event location string (city, state, venue)

Clean the tournament name from rawTitle:
  - Strip athlete prefixes: "Bella -", "Bella:", "Bella –" (and variations)
  - Strip org prefixes: "208 VBC -", "208 VBC:"
  - Remaining text is the tournament name
  - If no year is present (no 4-digit number), append the event year

Pick the single best match: the most recent event (highest eventDate) within the 21-day window.

**4c — Generate tournament slug**
From tournament name: lowercase, replace any char that is not a-z or 0-9 with a hyphen, collapse runs of hyphens, strip leading/trailing hyphens.
Examples:
  "Big Sky VolleyFest 2026" → "big-sky-volleyfest-2026"
  "ERVA Regional 2026" → "erva-regional-2026"
  "MT NW Jamboree 2026" → "mt-nw-jamboree-2026"

**4d — Determine all tournament dates for TOURNAMENT_WINDOWS**
From the calendar event: collect all YYYY-MM-DD dates spanned by the event (start through end inclusive). This becomes the `dates` array in TOURNAMENT_WINDOWS.

**4e — Timezone from event location**
Scan the location string for state/city clues:
  Mountain Time (America/Denver): Montana, MT, Wyoming, WY, Colorado, CO, Utah, UT, Billings, Missoula, Bozeman, Great Falls, Helena
  Pacific Time (America/Los_Angeles): Washington, WA, Oregon, OR, Idaho, ID, California, CA, Nevada, NV, Spokane, Boise, Seattle, Portland
  Default if no match: America/Denver

**4f — Fallback if no calendar event found**
Use today's date. Slug = "unmatched-YYYY-MM-DD". Timezone = "America/Denver".
Log: "⚠️ No calendar event found — added with placeholder slug. Review hudl-broadcasts.js."

---

### Step 5 — Write updates via Python

Construct and execute this Python script via bash with all variables populated from Step 4:

```python
#!/usr/bin/env python3
import re

FILE = "/Users/louisswingrover/Developer/sport-tracker/apps/volleywatch/lib/hudl-broadcasts.js"

# Populate before running:
new_entries = [
    # { "broadcastId": "...", "opponent": "...", "date": "YYYY-MM-DD",
    #   "tournament": "slug", "tournament_name": "Full Name YYYY",
    #   "tournament_dates": ["YYYY-MM-DD", ...] }
]

new_windows = [
    # Only slugs NOT already in TOURNAMENT_WINDOWS:
    # { "slug": "...", "dates": ["YYYY-MM-DD", ...], "timezone": "America/Denver" }
]

content = open(FILE).read()
original = content

# ── Insert HUDL_BROADCASTS entries ──────────────────────────────────────────
for entry in new_entries:
    b_id    = entry["broadcastId"]
    opp     = entry["opponent"]
    date    = entry["date"]
    slug    = entry["tournament"]
    t_name  = entry.get("tournament_name", slug)
    t_dates = entry.get("tournament_dates", [date])

    new_line = f'  {{ broadcastId: "{b_id}", opponent: "{opp}", date: "{date}", tournament: "{slug}" }},\n'

    slug_pattern = re.compile(
        rf'^\s*\{{[^}}]*tournament:\s*"{re.escape(slug)}"[^}}]*\}},?',
        re.MULTILINE
    )
    matches = list(slug_pattern.finditer(content))

    if matches:
        last = matches[-1]
        insert_at = content.index('\n', last.start()) + 1
        content = content[:insert_at] + new_line + content[insert_at:]
    else:
        dates_label = " — ".join(t_dates[:2]) if len(t_dates) > 1 else t_dates[0]
        header = f'  // {t_name} — {dates_label}\n'
        marker = "export const HUDL_BROADCASTS = [\n"
        pos = content.index(marker) + len(marker)
        content = content[:pos] + header + new_line + "\n" + content[pos:]

# ── Insert TOURNAMENT_WINDOWS entries ────────────────────────────────────────
for win in new_windows:
    slug  = win["slug"]
    dates = win["dates"]
    tz    = win["timezone"]
    if f'slug: "{slug}"' in content:
        continue
    dates_js = ", ".join(f'"{d}"' for d in dates)
    win_line = f'  {{ slug: "{slug}", dates: [{dates_js}], timezone: "{tz}" }},\n'
    marker = "export const TOURNAMENT_WINDOWS = [\n"
    pos = content.index(marker) + len(marker)
    content = content[:pos] + win_line + content[pos:]

if content == original:
    print("No changes written.")
else:
    open(FILE, "w").write(content)
    print("File updated successfully.")
```

After running: read the file back and verify every new broadcastId is present. If any are missing, log the error and do NOT commit.

---

### Step 6 — Commit and push

```bash
cd /Users/louisswingrover/Developer/sport-tracker
git add apps/volleywatch/lib/hudl-broadcasts.js
git -c commit.gpgsign=false commit -m 'feat: auto-sync Hudl broadcasts — [comma-separated opponent list]'
```

Push via osascript MCP:
```applescript
do shell script "cd '/Users/louisswingrover/Developer/sport-tracker' && git push origin main 2>&1"
```

---

### Step 7 — Log

```
[hudl-broadcast-sync] YYYY-MM-DD
New broadcasts added: N
  • Opponent Name (tournament-slug, YYYY-MM-DD)
New TOURNAMENT_WINDOWS: slug (if added)
Committed and pushed ✓

— OR —

No new broadcasts found. Nothing to do.
```

If any step fails (Hudl unreachable, git error, Python error): log the error in full and exit without committing.
