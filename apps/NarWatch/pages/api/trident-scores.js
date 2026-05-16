// NarWatch: Team Orlando WPC Google Sheets adapter for Trident Cup 2026.
//
// Fetches the published Google Sheet from teamorlandowpc.com and parses
// the Game_Scores tab for North Idaho 18U Boys games.
//
// Google Sheet (published HTML):
//   Spreadsheet: teamorlandowpc.com competition results
//   Game_Scores tab gid: 338166134
//   TeamBrackets tab gid: 580382339
//
// Columns (Game_Scores): GM, Div, Day, Pool, Time, Dark caps, Dk Score,
//                         Light caps, Lt Score, Winner
//
// North Idaho is identified by team name containing "north idaho" or "narwhal"
// (case-insensitive). Provisional scores have a "?" suffix.
//
// OUTPUT: same shape mergeNiwpIntoStatic() consumes —
//   { games: [{ id, opponent, done, result, score, sets }] }
//
// CACHE: 5-minute in-memory cache per Vercel serverless instance.

const SHEET_BASE =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQteqpqxhQp_nXeLY-KgZbwX1dtIpi7rlHUy5QScz1-XK7VaWGlIB51ejGBa1HuM2_pLtkzJES-SoLt";
const SCORES_URL = `${SHEET_BASE}/pubhtml?gid=338166134&single=true`;
const BRACKETS_URL = `${SHEET_BASE}/pubhtml?gid=580382339&single=true`;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const NI_PATTERNS = /north\s*idaho|narwhal/i;

// Module-level cache
let cache = null;

// ─── HTML table parser ────────────────────────────────────────────────────────

/**
 * Minimal HTML table parser — no DOM deps so it works in Node/Edge.
 * Finds all <tr> blocks, extracts text content of each <td>/<th>.
 * Returns array of string arrays (rows × cells).
 */
function parseHtmlTable(html) {
  const rows = [];
  // Match each <tr> block
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(rowHtml)) !== null) {
      // Strip inner tags, decode basic HTML entities, collapse whitespace
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

/**
 * Find the header row index in a rows array.
 * Looks for the row whose cells include "GM" and "Dark caps" (or similar).
 */
function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map((c) => c.toLowerCase());
    if (lower.includes("gm") && (lower.includes("dark caps") || lower.includes("dk score"))) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse a score string — may have "?" suffix for provisional scores.
 * Returns the integer value or null.
 */
function parseScore(str) {
  if (!str) return null;
  const n = parseInt(str.replace(/\?/g, "").trim(), 10);
  return isNaN(n) ? null : n;
}

// ─── Core parse logic ─────────────────────────────────────────────────────────

/**
 * Parse the Game_Scores HTML into an array of game objects shaped for
 * mergeNiwpIntoStatic().
 *
 * Columns (0-based, from header row):
 *   0  GM         game number
 *   1  Div        division (e.g. "18U Boys")
 *   2  Day        day label
 *   3  Pool       pool/court
 *   4  Time       game time string
 *   5  Dark caps  dark-cap team name
 *   6  Dk Score   dark score (may have "?")
 *   7  Light caps light-cap team name
 *   8  Lt Score   light score (may have "?")
 *   9  Winner     winning team name or empty
 */
function parseScoresHtml(html) {
  const rows = parseHtmlTable(html);
  const headerIdx = findHeaderRow(rows);
  if (headerIdx === -1) return [];

  // Build column index map from header
  const header = rows[headerIdx].map((c) => c.toLowerCase().trim());
  const col = {
    gm:        header.indexOf("gm"),
    div:       header.indexOf("div"),
    dark:      header.findIndex((h) => h.includes("dark")),
    dkScore:   header.findIndex((h) => h.includes("dk") && h.includes("score")),
    light:     header.findIndex((h) => h.includes("light") || h.includes("lt cap")),
    ltScore:   header.findIndex((h) => (h.includes("lt") || h.includes("light")) && h.includes("score")),
    winner:    header.findIndex((h) => h.includes("winner")),
  };

  const games = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 6) continue;

    const div = col.div >= 0 ? (row[col.div] || "") : "";
    // Only 18U Boys games
    if (div && !/18u?\s*b/i.test(div)) continue;

    const darkTeam  = col.dark    >= 0 ? (row[col.dark]    || "") : "";
    const lightTeam = col.light   >= 0 ? (row[col.light]   || "") : "";

    // Does North Idaho appear on either side?
    const niIsDark  = NI_PATTERNS.test(darkTeam);
    const niIsLight = NI_PATTERNS.test(lightTeam);
    if (!niIsDark && !niIsLight) continue;

    const dkRaw = col.dkScore >= 0 ? (row[col.dkScore] || "") : "";
    const ltRaw = col.ltScore >= 0 ? (row[col.ltScore] || "") : "";
    const winnerRaw = col.winner >= 0 ? (row[col.winner] || "") : "";

    const dkScore = parseScore(dkRaw);
    const ltScore = parseScore(ltRaw);

    // A game is "done" when both scores are present (even provisional) and
    // the winner field is populated.
    const isProvisional = dkRaw.includes("?") || ltRaw.includes("?");
    const done = dkScore !== null && ltScore !== null && winnerRaw.length > 0;

    const niScore    = niIsDark ? dkScore : ltScore;
    const themScore  = niIsDark ? ltScore : dkScore;
    const opponent   = niIsDark ? lightTeam : darkTeam;

    let result = null;
    if (done) {
      const niWon = NI_PATTERNS.test(winnerRaw);
      result = niWon ? "W" : "L";
    }

    const scoreStr =
      niScore !== null && themScore !== null
        ? `${niScore}–${themScore}`
        : null;

    const sets =
      niScore !== null && themScore !== null
        ? [{ us: niScore, them: themScore }]
        : [];

    const gmNum = col.gm >= 0 ? (row[col.gm] || "").trim() : "";
    const id    = `trident-2026-sheets-g${gmNum || i}`;

    games.push({
      id,
      gmNum,
      opponent: opponent.trim(),
      done,
      result,
      score: scoreStr,
      sets,
      provisional: isProvisional,
    });
  }

  return games;
}

// ─── API handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Serve from cache if fresh
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cache.payload);
  }

  try {
    const response = await fetch(SCORES_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      // 8-second timeout via AbortController
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(`Sheets fetch failed: ${response.status}`);
    }

    const html = await response.text();
    const games = parseScoresHtml(html);

    const payload = {
      games,
      fetchedAt: new Date().toISOString(),
      source: "teamorlandowpc-sheets",
    };

    cache = { fetchedAt: Date.now(), payload };

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[trident-scores] fetch error:", err.message);

    // Return stale cache if available rather than hard-failing
    if (cache) {
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json({ ...cache.payload, stale: true });
    }

    return res.status(502).json({ error: "Failed to fetch Trident Cup scores", detail: err.message });
  }
}
