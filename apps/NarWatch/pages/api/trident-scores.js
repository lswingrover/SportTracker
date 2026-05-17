// NarWatch: Team Orlando WPC Google Sheets adapter for Trident Cup 2026.
//
// PREVIOUS: used pubhtml endpoint which returns a JS-rendered shell with no
// table content. FIXED: uses CSV export endpoints which return raw data.
//
// Fetches the published Google Sheet from teamorlandowpc.com:
//   • Game_Scores tab (gid=338166134)  → all 18U Boys game results
//   • TeamBrackets tab (gid=580382339) → pool assignments + bracket rankings
//
// OUTPUT:
//   {
//     games: [{ id, gmNum, opponent, done, result, score, sets }],  ← NI games only
//     bracketSlots: { "2M": "Team Name", ... },
//     standings: [{ teamId, teamName, isUs, rank, pool, matchesWon,
//                   matchesLost, goalDiff, goalsFor, setPercent }],  ← all 9 teams
//     fetchedAt: ISO string,
//     source: "teamorlandowpc-sheets-csv",
//   }
//
// CACHE: 5-minute in-memory cache per Vercel serverless instance.

const SHEET_BASE =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQteqpqxhQp_nXeLY-KgZbwX1dtIpi7rlHUy5QScz1-XK7VaWGlIB51ejGBa1HuM2_pLtkzJES-SoLt";
const SCORES_CSV_URL   = `${SHEET_BASE}/pub?gid=338166134&single=true&output=csv`;
const BRACKETS_CSV_URL = `${SHEET_BASE}/pub?gid=580382339&single=true&output=csv`;

const CACHE_TTL_MS = 5 * 60 * 1000;
const NI_PATTERNS = /north\s*idaho|narwhal/i;
const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; NarWatch/1.0)" };

let cache = null;

// ─── CSV parser ───────────────────────────────────────────────────────────────
// Handles quoted fields with embedded commas and escaped double-quotes.

function parseCsv(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cells = [];
    let inQuote = false, cell = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        cells.push(cell); cell = "";
      } else {
        cell += ch;
      }
    }
    cells.push(cell.replace(/\r$/, ""));
    rows.push(cells);
  }
  return rows;
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ─── Game_Scores CSV parser ───────────────────────────────────────────────────
// Columns: GM, Div, Day, Pool, Time, Dark caps, Dk Score, Light caps, Lt Score, Winner

function parseGameScoresCsv(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];

  const hdr = rows[0].map((c) => c.trim().toLowerCase());
  const c = {
    gm:      hdr.indexOf("gm"),
    div:     hdr.indexOf("div"),
    dark:    hdr.findIndex((h) => h.includes("dark")),
    dkScore: hdr.findIndex((h) => h.includes("dk") && h.includes("score")),
    light:   hdr.findIndex((h) => h.includes("light") || h.includes("lt cap")),
    ltScore: hdr.findIndex((h) => (h.includes("lt") || h.includes("light")) && h.includes("score")),
    winner:  hdr.findIndex((h) => h.includes("winner")),
  };

  const games = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const div = c.div >= 0 ? (row[c.div] || "") : "";
    if (!/18u.*boy/i.test(div)) continue;

    const dark    = (row[c.dark]    || "").trim();
    const light   = (row[c.light]   || "").trim();
    const dkScore = parseInt(row[c.dkScore] || "", 10);
    const ltScore = parseInt(row[c.ltScore] || "", 10);
    const winner  = (row[c.winner]  || "").trim();
    const gm      = (row[c.gm]      || "").trim();
    if (!dark || !light) continue;

    const done = !isNaN(dkScore) && !isNaN(ltScore) && winner.length > 0;
    const niIsDark  = NI_PATTERNS.test(dark);
    const niIsLight = NI_PATTERNS.test(light);
    const isNiGame  = niIsDark || niIsLight;

    games.push({
      gm: parseInt(gm, 10) || 0,
      dark, light,
      dkScore: done ? dkScore : null,
      ltScore: done ? ltScore : null,
      winner,
      done,
      // NI-specific (undefined for non-NI games)
      ...(isNiGame && done ? {
        niGame: true,
        opponent:  niIsDark ? light : dark,
        result:    NI_PATTERNS.test(winner) ? "W" : "L",
        score:     `${niIsDark ? dkScore : ltScore}–${niIsDark ? ltScore : dkScore}`,
        sets:      [{ us: niIsDark ? dkScore : ltScore, them: niIsDark ? ltScore : dkScore }],
      } : {}),
    });
  }
  return games;
}

// ─── TeamBrackets CSV parser ──────────────────────────────────────────────────
// Bracket Status section: Division, Bracket (pool letter), Team_Name, Wins, Brk_Rank

function parseBracketsCsv(csvText) {
  const rows = parseCsv(csvText);

  // Locate the "Team_Name" header row (bracket status table starts there).
  let hdrIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((c) => c.trim() === "Team_Name")) { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) return { teamInfo: {}, bracketSlots: {} };

  const hdr = rows[hdrIdx].map((c) => c.trim());
  const c = {
    div:     hdr.indexOf("Division"),
    bracket: hdr.indexOf("Bracket"),
    name:    hdr.indexOf("Team_Name"),
    wins:    hdr.indexOf("Wins"),
    brkRank: hdr.indexOf("Brk_Rank"),
  };

  const teamInfo = {};   // keyed by lowercase team name
  const bracketSlots = {};  // e.g. "2M" → "Gladiators"

  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const div     = (row[c.div]     || "").trim();
    const pool    = (row[c.bracket] || "").trim();
    const name    = (row[c.name]    || "").trim();
    const wins    = parseInt(row[c.wins]    || "0", 10) || 0;
    const brkRank = parseInt(row[c.brkRank] || "0", 10) || 0;
    if (!name || !pool) continue;

    if (/18u.*boy/i.test(div)) {
      teamInfo[name.toLowerCase()] = { pool, poolRank: brkRank || 99, totalWins: wins, displayName: name };
      // bracketSlot key = "{rank}{pool}" e.g. "2N"
      if (brkRank >= 1 && brkRank <= 3) {
        bracketSlots[`${brkRank}${pool}`] = name;
      }
    }
  }

  return { teamInfo, bracketSlots };
}

// ─── Standings builder ────────────────────────────────────────────────────────
// Computes W/L/GF/GA from pool-play games only (same-pool matchups).

function buildStandings(games, teamInfo) {
  // Build per-team stat buckets
  const stats = {};
  for (const [, info] of Object.entries(teamInfo)) {
    stats[info.displayName] = {
      pool: info.pool,
      poolRank: info.poolRank,
      wins: 0, losses: 0, goalsFor: 0, goalsAgainst: 0,
    };
  }

  // Fuzzy team-name lookup against stats keys
  function findKey(name) {
    const n = name.toLowerCase().trim();
    for (const k of Object.keys(stats)) {
      if (k.toLowerCase() === n) return k;
    }
    for (const k of Object.keys(stats)) {
      const kl = k.toLowerCase();
      if (n.startsWith(kl) || kl.startsWith(n)) return k;
    }
    // Partial word overlap
    for (const k of Object.keys(stats)) {
      const words = k.toLowerCase().split(/\s+/);
      if (words.some((w) => w.length > 3 && n.includes(w))) return k;
    }
    return null;
  }

  for (const g of games) {
    if (!g.done || g.dkScore == null || g.ltScore == null) continue;
    const darkKey  = findKey(g.dark);
    const lightKey = findKey(g.light);
    // Only count same-pool matchups (pool play)
    if (!darkKey || !lightKey) continue;
    if (stats[darkKey].pool !== stats[lightKey].pool) continue;

    const darkWon = g.dkScore > g.ltScore;
    stats[darkKey].wins    += darkWon ? 1 : 0;
    stats[darkKey].losses  += darkWon ? 0 : 1;
    stats[darkKey].goalsFor     += g.dkScore;
    stats[darkKey].goalsAgainst += g.ltScore;
    stats[lightKey].wins    += darkWon ? 0 : 1;
    stats[lightKey].losses  += darkWon ? 1 : 0;
    stats[lightKey].goalsFor     += g.ltScore;
    stats[lightKey].goalsAgainst += g.dkScore;
  }

  return Object.entries(stats)
    .map(([name, s]) => ({
      teamId:       slugify(name),
      teamName:     name,
      isUs:         NI_PATTERNS.test(name),
      rank:         s.poolRank,
      pool:         s.pool,
      matchesWon:   s.wins,
      matchesLost:  s.losses,
      goalDiff:     s.goalsFor - s.goalsAgainst,
      goalsFor:     s.goalsFor,
      setPercent:   0, // water polo has no sets
      earnedBid:    false,
      bidAlias:     null,
    }))
    .sort((a, b) => a.pool !== b.pool
      ? a.pool.localeCompare(b.pool)
      : a.rank - b.rank);
}

// ─── Push helpers ─────────────────────────────────────────────────────────────

async function maybePushScoreChanges(prevGames, nextGames) {
  try {
    const { pushConfigured, pushToTeam } = await import("@sport-tracker/core/push.js");
    if (!pushConfigured()) return;

    const prevById = Object.fromEntries(
      (prevGames || []).filter((g) => g.niGame).map((g) => [g.gm, g])
    );

    for (const g of nextGames) {
      if (!g.niGame || !g.done) continue;
      const prev = prevById[g.gm];
      if (prev?.done) continue;

      const isBracket = g.gm >= 56;
      const resultWord = g.result === "W" ? "WIN" : "LOSS";
      await pushToTeam("narwhals", {
        title: `Narwhals ${resultWord} ${g.score || ""}`,
        body:  `vs ${g.opponent} — Game ${g.gm}`,
        tag:   `game-result-trident-${g.gm}`,
        url:   "/",
      }, "final-result");

      if (isBracket) {
        await pushToTeam("narwhals", {
          title: "Bracket update — Narwhals",
          body:  `Game ${g.gm}: ${resultWord} ${g.score || ""} vs ${g.opponent}`,
          tag:   `bracket-trident-${g.gm}`,
          url:   "/",
        }, "bracket-advance");
      }
    }
  } catch (err) {
    console.error("[trident-scores] push error:", err.message);
  }
}

// ─── API handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cache.payload);
  }

  try {
    const [scoresResp, bracketsResp] = await Promise.all([
      fetch(SCORES_CSV_URL,   { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) }),
      fetch(BRACKETS_CSV_URL, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) }),
    ]);

    if (!scoresResp.ok)   throw new Error(`Scores CSV fetch failed: ${scoresResp.status}`);
    if (!bracketsResp.ok) throw new Error(`Brackets CSV fetch failed: ${bracketsResp.status}`);

    const [scoresCsv, bracketsCsv] = await Promise.all([
      scoresResp.text(),
      bracketsResp.text(),
    ]);

    const games                      = parseGameScoresCsv(scoresCsv);
    const { teamInfo, bracketSlots } = parseBracketsCsv(bracketsCsv);
    const standings                  = buildStandings(games, teamInfo);

    // NI-only games in the shape mergeNiwpIntoStatic expects
    const niGames = games
      .filter((g) => g.niGame && g.done)
      .map((g, i) => ({
        id:       `trident-2026-sheets-g${g.gm || i}`,
        gmNum:    String(g.gm),
        opponent: g.opponent,
        done:     true,
        result:   g.result,
        score:    g.score,
        sets:     g.sets,
      }));

    const payload = {
      games:        niGames,
      bracketSlots,
      standings,
      fetchedAt:    new Date().toISOString(),
      source:       "teamorlandowpc-sheets-csv",
    };

    maybePushScoreChanges(cache?.payload?.games, niGames);
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
