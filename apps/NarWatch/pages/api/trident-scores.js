// NarWatch: Team Orlando WPC Google Sheets adapter for Trident Cup 2026.
//
// Fetches the published Google Sheet from teamorlandowpc.com and parses:
//   • Game_Scores tab (gid=338166134)  → North Idaho 18U Boys game results
//   • TeamBrackets tab (gid=580382339) → bracket seedings (2M, 2N, 2O, etc.)
//
// Columns (Game_Scores): GM, Div, Day, Pool, Time, Dark caps, Dk Score,
//                         Light caps, Lt Score, Winner
//
// North Idaho is identified by team name containing "north idaho" or "narwhal"
// (case-insensitive). Provisional scores have a "?" suffix.
//
// OUTPUT:
//   {
//     games: [{ id, gmNum, opponent, done, result, score, sets, provisional }],
//     bracketSlots: { "2M": "Team Name", "2N": "...", "2O": "..." },
//     fetchedAt: ISO string,
//     source: "teamorlandowpc-sheets",
//   }
//
// index.jsx consumes `games` via mergeNiwpIntoStatic() and `bracketSlots` via
// applyBracketSlots() to fill in TBD opponent names on bracket games.
//
// CACHE: 5-minute in-memory cache per Vercel serverless instance.

const SHEET_BASE =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQteqpqxhQp_nXeLY-KgZbwX1dtIpi7rlHUy5QScz1-XK7VaWGlIB51ejGBa1HuM2_pLtkzJES-SoLt";
const SCORES_URL   = `${SHEET_BASE}/pubhtml?gid=338166134&single=true`;
const BRACKETS_URL = `${SHEET_BASE}/pubhtml?gid=580382339&single=true`;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const NI_PATTERNS = /north\s*idaho|narwhal/i;

// Module-level cache
let cache = null;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

// ─── HTML table parser ────────────────────────────────────────────────────────

function parseHtmlTable(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(rowHtml)) !== null) {
      const text = tdMatch[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function findHeaderRow(rows, mustHave) {
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map((c) => c.toLowerCase());
    if (mustHave.every((kw) => lower.some((cell) => cell.includes(kw)))) {
      return i;
    }
  }
  return -1;
}

function parseScore(str) {
  if (!str) return null;
  const n = parseInt(str.replace(/\?/g, "").trim(), 10);
  return isNaN(n) ? null : n;
}

// ─── Game_Scores parser ───────────────────────────────────────────────────────

function parseScoresHtml(html) {
  const rows = parseHtmlTable(html);
  const headerIdx = findHeaderRow(rows, ["gm", "dk"]);
  if (headerIdx === -1) return [];

  const header = rows[headerIdx].map((c) => c.toLowerCase().trim());
  const col = {
    gm:      header.indexOf("gm"),
    div:     header.indexOf("div"),
    dark:    header.findIndex((h) => h.includes("dark")),
    dkScore: header.findIndex((h) => h.includes("dk") && h.includes("score")),
    light:   header.findIndex((h) => h.includes("light") || h.includes("lt cap")),
    ltScore: header.findIndex((h) => (h.includes("lt") || h.includes("light")) && h.includes("score")),
    winner:  header.findIndex((h) => h.includes("winner")),
  };

  const games = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 6) continue;

    const div = col.div >= 0 ? (row[col.div] || "") : "";
    if (div && !/18u?\s*b/i.test(div)) continue;

    const darkTeam  = col.dark  >= 0 ? (row[col.dark]  || "") : "";
    const lightTeam = col.light >= 0 ? (row[col.light] || "") : "";

    const niIsDark  = NI_PATTERNS.test(darkTeam);
    const niIsLight = NI_PATTERNS.test(lightTeam);
    if (!niIsDark && !niIsLight) continue;

    const dkRaw    = col.dkScore >= 0 ? (row[col.dkScore] || "") : "";
    const ltRaw    = col.ltScore >= 0 ? (row[col.ltScore] || "") : "";
    const winnerRaw = col.winner >= 0 ? (row[col.winner] || "") : "";

    const dkScore = parseScore(dkRaw);
    const ltScore = parseScore(ltRaw);

    const isProvisional = dkRaw.includes("?") || ltRaw.includes("?");
    const done = dkScore !== null && ltScore !== null && winnerRaw.length > 0;

    const niScore   = niIsDark ? dkScore : ltScore;
    const themScore = niIsDark ? ltScore : dkScore;
    const opponent  = niIsDark ? lightTeam : darkTeam;

    let result = null;
    if (done) result = NI_PATTERNS.test(winnerRaw) ? "W" : "L";

    const scoreStr = niScore !== null && themScore !== null ? `${niScore}–${themScore}` : null;
    const sets     = niScore !== null && themScore !== null ? [{ us: niScore, them: themScore }] : [];

    const gmNum = col.gm >= 0 ? (row[col.gm] || "").trim() : "";

    games.push({
      id:          `trident-2026-sheets-g${gmNum || i}`,
      gmNum,
      opponent:    opponent.trim(),
      done,
      result,
      score:       scoreStr,
      sets,
      provisional: isProvisional,
    });
  }

  return games;
}

// ─── TeamBrackets parser ──────────────────────────────────────────────────────
//
// We don't know the exact column layout until we see the sheet, so we use a
// multi-strategy approach:
//
// Strategy A — direct slot column: look for a column whose header matches
//   /slot|seed|place|bracket/i and a team-name column. Each row like
//   ["2M", "Team Fury"] maps slot→team directly.
//
// Strategy B — pool + place columns: look for "pool" and "place" (or
//   "finish"/"rank") columns. Combine pool letter + place number → slot key.
//
// Strategy C — free scan: scan every row for cells matching /^[12]\s*[A-Z]$/
//   (e.g. "2M", "1N"). The adjacent cell is likely the team name.
//
// Returns { "1M": "...", "2M": "...", "1N": "...", "2N": "...", ... }

function parseBracketsHtml(html) {
  const slots = {};
  if (!html) return slots;

  const rows = parseHtmlTable(html);
  if (!rows.length) return slots;

  // Find the header row — look for any row with "pool" or "place" or "seed"
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map((c) => c.toLowerCase());
    if (lower.some((c) => c.includes("pool") || c.includes("place") || c.includes("seed") || c.includes("slot"))) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx >= 0) {
    const header = rows[headerIdx].map((c) => c.toLowerCase().trim());

    // Strategy A: explicit slot/seed column + team column
    const slotColA = header.findIndex((h) => /slot|seed|bracket/i.test(h));
    const teamColA = header.findIndex((h) => /team|name/i.test(h));
    if (slotColA >= 0 && teamColA >= 0) {
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const slotVal = (row[slotColA] || "").trim();
        const teamVal = (row[teamColA] || "").trim();
        if (/^[12][A-Z]$/i.test(slotVal) && teamVal) {
          slots[slotVal.toUpperCase()] = teamVal;
        }
      }
      if (Object.keys(slots).length) return slots;
    }

    // Strategy B: pool + place/finish + team
    const poolCol  = header.findIndex((h) => h === "pool" || h.includes("pool"));
    const placeCol = header.findIndex((h) => /place|finish|rank|pos/i.test(h));
    const teamCol  = header.findIndex((h) => /team|name/i.test(h));
    if (poolCol >= 0 && placeCol >= 0 && teamCol >= 0) {
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const pool  = (row[poolCol]  || "").trim().toUpperCase();
        const place = (row[placeCol] || "").trim();
        const team  = (row[teamCol]  || "").trim();
        const placeNum = parseInt(place, 10);
        if (pool && !isNaN(placeNum) && team) {
          slots[`${placeNum}${pool}`] = team;
        }
      }
      if (Object.keys(slots).length) return slots;
    }
  }

  // Strategy C: free scan for /^[12][A-Z]$/ cells
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const cell = row[c].trim();
      if (/^[12][A-Z]$/i.test(cell)) {
        // Look right for a non-empty team name (next 1-2 cells)
        for (let offset = 1; offset <= 2; offset++) {
          const candidate = (row[c + offset] || "").trim();
          if (candidate && !/^\d+$/.test(candidate)) {
            slots[cell.toUpperCase()] = candidate;
            break;
          }
        }
      }
    }
  }

  return slots;
}

// ─── API handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cache.payload);
  }

  try {
    // Fetch both sheets in parallel
    const [scoresResp, bracketsResp] = await Promise.all([
      fetch(SCORES_URL,   { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) }),
      fetch(BRACKETS_URL, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) }),
    ]);

    if (!scoresResp.ok) throw new Error(`Scores fetch failed: ${scoresResp.status}`);

    const [scoresHtml, bracketsHtml] = await Promise.all([
      scoresResp.text(),
      bracketsResp.ok ? bracketsResp.text() : Promise.resolve(""),
    ]);

    const games        = parseScoresHtml(scoresHtml);
    const bracketSlots = parseBracketsHtml(bracketsHtml);

    const payload = {
      games,
      bracketSlots,
      fetchedAt: new Date().toISOString(),
      source: "teamorlandowpc-sheets",
    };

    cache = { fetchedAt: Date.now(), payload };

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[trident-scores] fetch error:", err.message);
    if (cache) {
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json({ ...cache.payload, stale: true });
    }
    return res.status(502).json({ error: "Failed to fetch Trident Cup scores", detail: err.message });
  }
}
