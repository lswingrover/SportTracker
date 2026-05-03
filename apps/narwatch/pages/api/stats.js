// NarWatch: per-game player stats endpoint.
//
// Fetches player stat lines from the NIWP WordPress REST API for a
// specific game and returns them sorted by goals descending.
//
// USAGE:
//   GET /api/stats?game_id=42
//
// RESPONSE:
//   {
//     game_id: 42,
//     stats: [
//       { stat_id, player_id, player_name, cap_number, goals, assists,
//         steals, blocks, kickouts },
//       ...
//     ],
//     fetchedAt: <ISO string>,
//     cached: false
//   }
//
// CACHE: 2-minute TTL per game_id.

const NIWP_BASE = "https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1";
const CACHE_TTL_MS = 2 * 60 * 1000;

const cacheMap = new Map(); // game_id (string) → { payload, fetchedAt }

function normalizeInt(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : Math.max(0, Math.floor(n));
}

async function fetchStats(gameId) {
  const url = `${NIWP_BASE}/games/${encodeURIComponent(gameId)}/stats`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
  });
  if (!res.ok) throw new Error(`NIWP stats API ${res.status} for game ${gameId}`);
  const json = await res.json();
  // API returns {success, data:[...]} envelope
  const raw = Array.isArray(json) ? json : (json.data || []);

  const stats = raw
    .map((s) => ({
      stat_id:     s.stat_id,
      player_id:   s.player_id,
      player_name: s.player_name || "Unknown",
      cap_number:  s.cap_number  || null,
      goals:       normalizeInt(s.goals),
      assists:     normalizeInt(s.assists),
      steals:      normalizeInt(s.steals),
      blocks:      normalizeInt(s.blocks),
      kickouts:    normalizeInt(s.kickouts),
    }))
    // Sort: goals desc → assists desc → name asc
    .sort((a, b) => {
      if (b.goals    !== a.goals)    return b.goals    - a.goals;
      if (b.assists  !== a.assists)  return b.assists  - a.assists;
      return (a.player_name || "").localeCompare(b.player_name || "");
    });

  return {
    game_id:   gameId,
    stats,
    fetchedAt: new Date().toISOString(),
    cached:    false,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const gameId = req.query?.game_id;
  if (!gameId) {
    res.status(400).json({ error: "missing_param", detail: "game_id is required" });
    return;
  }

  const key   = String(gameId);
  const force = req.query?.force === "1";
  const now   = Date.now();
  const entry = cacheMap.get(key);

  if (!force && entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.status(200).json({ ...entry.payload, cached: true });
    return;
  }

  try {
    const payload = await fetchStats(key);
    cacheMap.set(key, { payload, fetchedAt: now });
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.status(200).json(payload);
  } catch (err) {
    if (entry) {
      console.error("[stats] fetch failed, serving stale cache:", err.message);
      res.status(200).json({
        ...entry.payload,
        cached:         true,
        _staleError:    String(err.message),
        _staleServedAt: new Date().toISOString(),
      });
      return;
    }
    console.error("[stats] fetch failed, no cache:", err.message);
    res.status(502).json({ error: "stats_fetch_failed", detail: String(err.message) });
  }
}
