# NarWatch: Google Sheets Live Data Setup

The Google Sheets integration is the **universal fallback** for tournaments
where no official scoring API is available. A team parent opens a shared
sheet, types scores as games finish, and NarWatch polls it every 60 seconds.

---

## Sheet Schema

Create a Google Sheet with **three tabs** named exactly as shown.

### Tab 1: Config

Key/value pairs in columns A and B. Header row optional (skipped if first cell doesn't look like a value).

| A (Key)         | B (Value)                          |
|-----------------|------------------------------------|
| Tournament Name | North Idaho Cup 2026               |
| Location        | Coeur d'Alene Aquatic Center       |
| Date            | 2026-06-14                         |
| End Date        | 2026-06-15                         |
| Team Name       | North Idaho Narwhals               |
| Team ID         | narwhals                           |
| Tournament ID   | cda-2026                           |
| Timezone        | America/Los_Angeles                |

All fields are optional — sensible defaults apply if omitted.

---

### Tab 2: Games

**Row 1 must be headers** (exact names below — case-insensitive, order flexible).

| Column       | Header        | Notes                                              |
|--------------|---------------|----------------------------------------------------|
| A            | Game ID       | Any unique string. Auto-assigned if blank.         |
| B            | Date          | 2026-06-14 (ISO or US format)                      |
| C            | Time          | 9:00 AM                                            |
| D            | Round         | Pool Play / Quarterfinal / Semifinal / Final        |
| E            | Opponent      | Team name (required — blank rows are skipped)      |
| F            | NIWP Score    | Our final score (number)                           |
| G            | Opp Score     | Their final score (number)                         |
| H            | W/L           | Formula: `=IF(OR(F2="",G2=""),"",IF(F2>G2,"W","L"))` |
| I            | Done          | TRUE once the game is finished (or auto-set if scores are entered) |
| J            | Court         | Court 3 / Pool A / etc.                            |
| K            | Notes         | Any free-text note                                 |

**W/L formula for every data row** (paste into H2, drag down):
```
=IF(OR(F2="",G2=""),"",IF(F2>G2,"W","L"))
```

**Done formula** (optional — paste into I2, drag down):
```
=AND(F2<>"",G2<>"")
```

**Example data row:**
```
g-1 | 2026-06-14 | 9:00 AM | Pool Play | Coeur d'Alene Waves | 8 | 5 | W | TRUE | Court 2 | Strong first half
```

---

### Tab 3: Standings

Optional. If this tab is blank or absent, NarWatch auto-derives standings from
the Games tab.

**Row 1 must be headers:**

| Column | Header    | Notes                                      |
|--------|-----------|--------------------------------------------|
| A      | Rank      | 1, 2, 3…                                   |
| B      | Team Name | Full team name                             |
| C      | Wins      | Number                                     |
| D      | Losses    | Number                                     |
| E      | Goal Diff | Positive or negative integer               |
| F      | Is Us     | TRUE for the Narwhals row                  |

---

## Quickstart: Copy the Template

Rather than building the sheet from scratch, use this structure as a starting
point. Create a new Google Sheet, add three tabs named `Config`, `Games`, and
`Standings`, and copy the headers above into row 1 of each.

---

## Activating the Integration

### 1. Share the sheet

`File → Share → Share with others → Change to "Anyone with the link" → Viewer`

Copy the Sheet ID from the URL:
```
https://docs.google.com/spreadsheets/d/  ← YOUR_SHEET_ID →  /edit
```

### 2. Create an API key

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Select a project (or create one — "NarWatch" works).
3. **APIs & Services → Library → Google Sheets API → Enable**.
4. **APIs & Services → Credentials → Create Credentials → API key**.
5. Click **Restrict key**:
   - Application restrictions: none (or HTTP referrers if you want to lock it down)
   - API restrictions: **Google Sheets API**
6. Copy the key.

### 3. Set env vars

**Local (`.env.local`):**
```
GOOGLE_SHEETS_ID=your-sheet-id-here
GOOGLE_SHEETS_API_KEY=your-api-key-here
```

**Railway / Vercel:** add the same two vars in the project environment settings.

### 4. Verify

Hit `/api/tournament?force=1` in the browser. You should see JSON with
`"_dataSource": "google-sheets"`. If you see an error, check the `detail`
field — it will tell you exactly what's wrong (wrong sheet ID, key not
authorized for Sheets API, sheet not public, etc.).

---

## Live Updates

NarWatch polls `/api/tournament` every **2 minutes** by default (the UI's
`REFRESH_MS` constant). The Sheets API endpoint uses a **60-second** server-
side cache, so new scores appear within ~3 minutes of entry.

To force an immediate refresh during a tournament, reload the PWA with
`?force=1` appended to the URL.

---

## Credentials Note

Louis's existing `GOOGLE_PERSONAL_CLIENT_ID` / OAuth credentials are **not
needed** here — this integration uses a simple API key against a public sheet,
which is simpler and doesn't require OAuth. The API key approach is read-only
by design and appropriate for a publicly viewable score sheet.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Sheets API 403` | Sheet is not public, or API key isn't authorized for the Sheets API |
| `Sheets API 404` | Wrong Sheet ID |
| `Missing env vars` | Both `GOOGLE_SHEETS_ID` and `GOOGLE_SHEETS_API_KEY` must be set |
| Games not showing | Check that the "Opponent" column is filled in — blank rows are skipped |
| W/L wrong | Enter scores in the NIWP Score and Opp Score columns; W/L is auto-computed |
