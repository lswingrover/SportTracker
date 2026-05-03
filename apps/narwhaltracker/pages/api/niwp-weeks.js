// NarWatch: available NIWP tournament weeks.
//
// Returns a sorted list of all calendar weeks that have CDA/NIWP game data,
// suitable for driving the frontend chip row (tournament selector).
//
// Response shape:
//   [{
//     weekKey:   "2026-W16",           // ISO year + week number
//     chipLabel: "Apr 19",             // short label for chip button
//     label:     "Bend · Apr 19–20",   // longer label for display
//     startDate: "2026-04-19",
//     endDate:   "2026-04-20",
//     location:  "Bend Aquatic Center" // dominant location or null
//   }, ...]
//
// Sorted oldest → newest. Front-end should treat the last entry as "current".
//
// Shares the CDA detection + week-grouping helpers from niwp.js. Cached for
// the same 60-second TTL so a chip-row refresh doesn't hammer NIWP.

const NIWP_BASE = "https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1";
const CACHE_TTL_MS = 60 * 1000;

const CDA_PATTERNS = ["cda", "coeur d'alene", "north idaho", "narwhal", "niwp"];

let _cache = null;
let _cachedAt = 0;

function isCDATeam(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return CDA_PATTERNS.some((p) => lower.includes(p));
}

function isoWeekKey(date) {
  // Returns "YYYY-Www" for the ISO week containing `date`.
  const d = new Date(date);
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const weekNum = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function dominantLocation(games) {
  const counts = {};
  for (const g of games) {
    const loc = g.location || "Unknown";
    counts[loc] = (counts[loc] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function shortDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

async function buildWeekList() {
  const res = await fetch(`${NIWP_BASE}/games`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
  });
  if (!res.ok) throw new Error(`NIWP games API ${res.status}`);
  const json = await res.json();
  const allGames = Array.isArray(json) ? json : (json.data || []);

  const cdaGames = allGames.filter(
    (g) => isCDATeam(g.home_team) || isCDATeam(g.away_team)
  );

  // Group by ISO week
  const byWeek = new Map();
  for (const g of cdaGames) {
    if (!g.game_date) continue;
    const d = new Date(g.game_date);
    if (isNaN(d.getTime())) continue;
    const key = isoWeekKey(d);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(g);
  }

  const sortedKeys = Array.from(byWeek.keys()).sort();

  return sortedKeys.map((weekKey) => {
    const games = byWeek.get(weekKey);
    // Sort games by date to find start/end
    const dates = games
      .map((g) => g.game_date)
      .filter(Boolean)
      .sort();
    const startDate = dates[0] || null;
    const endDate = dates[dates.length - 1] || null;
    const location = dominantLocation(games);
    const locName = location && location !== "Unknown" ? location : null;

    const startShort = shortDate(startDate);
    const endShort = shortDate(endDate);
    const dateRange =
      startDate === endDate || !endDate
        ? startShort
        : `${startShort}–${endShort}`;

    const chipLabel = startShort || weekKey;
    const label = locName ? `${locName} · ${dateRange}` : dateRange || weekKey;

    return { weekKey, chipLabel, label, startDate, endDate, location: locName };
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // Only serve when NIWP is the active data source
  if (process.env.NIWP_API_ENABLED !== "true") {
    res.status(200).json([]);
    return;
  }

  const force = req.query?.force === "1";
  const now = Date.now();

  if (!force && _cache && now - _cachedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.status(200).json(_cache);
    return;
  }

  try {
    const weeks = await buildWeekList();
    _cache = weeks;
    _cachedAt = now;
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.status(200).json(weeks);
  } catch (err) {
    if (_cache) {
      res.status(200).json(_cache);
      return;
    }
    console.error("[niwp-weeks] fetch failed:", err.message);
    res.status(502).json({ error: "niwp_weeks_failed", detail: String(err.message) });
  }
}
