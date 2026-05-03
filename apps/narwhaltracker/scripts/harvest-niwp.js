#!/usr/bin/env node
/**
 * NarWatch — NIWP Historical Data Harvester
 *
 * API envelope: { success: true, data: [...] }
 * Games fields: game_id, home_team, away_team, location, game_date, home_score, away_score
 * Players fields: player_id, player_name, default_cap
 * Stats fields: stat_id, game_id, player_id, player_name, cap_number,
 *               goals, assists, steals, blocks, kickouts
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1";
const DATA_DIR = path.join(__dirname, "../data");
const RATE_LIMIT_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "NarWatch/1.0 data-harvest" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            // Unwrap the WordPress API envelope
            if (parsed && parsed.success === true && Array.isArray(parsed.data)) {
              resolve(parsed.data);
            } else if (Array.isArray(parsed)) {
              resolve(parsed);
            } else {
              resolve(parsed); // return as-is if unexpected shape
            }
          } catch (e) {
            reject(new Error(`JSON parse error for ${url}: ${e.message}\nBody: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
  });
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, json);
  const label = path.relative(DATA_DIR, filePath);
  const bytes = Buffer.byteLength(json);
  const count = Array.isArray(data) ? ` (${data.length} rows)` : "";
  console.log(`  ✓ ${label} — ${bytes.toLocaleString()} bytes${count}`);
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  NarWatch — NIWP Historical Data Harvest      ");
  console.log("═══════════════════════════════════════════════\n");

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ── 1. Fetch all games ────────────────────────────────────────────────────
  console.log("📋 Fetching all games…");
  const games = await fetchJSON(`${BASE_URL}/games`);
  writeJSON(path.join(DATA_DIR, "games.json"), games);
  console.log(`   → ${games.length} games\n`);

  // ── 2. Fetch all players ──────────────────────────────────────────────────
  console.log("👤 Fetching all players…");
  const players = await fetchJSON(`${BASE_URL}/players`);
  writeJSON(path.join(DATA_DIR, "players.json"), players);
  console.log(`   → ${players.length} players\n`);

  // ── 3. Fetch per-game stats (rate-limited) ────────────────────────────────
  console.log(`📊 Fetching per-game stats for ${games.length} games…`);
  const allStats = {};
  let successCount = 0;
  let emptyCount = 0;
  let errorCount = 0;

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    const gameId = game.game_id;
    if (!gameId) {
      console.warn(`   ⚠ Skipping game at index ${i} — no game_id`);
      continue;
    }

    const pct = `${i + 1}/${games.length}`;
    process.stdout.write(`   [${pct}] game ${gameId}… `);

    try {
      const stats = await fetchJSON(`${BASE_URL}/games/${gameId}/stats`);
      writeJSON(path.join(DATA_DIR, `stats_${gameId}.json`), stats);
      allStats[gameId] = stats;
      if (stats.length === 0) {
        process.stdout.write("(no stats)\n");
        emptyCount++;
      } else {
        process.stdout.write(`${stats.length} rows\n`);
        successCount++;
      }
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
      allStats[gameId] = [];
      errorCount++;
    }

    if (i < games.length - 1) await sleep(RATE_LIMIT_MS);
  }

  console.log(
    `\n   → ${successCount} with stats, ${emptyCount} empty, ${errorCount} errors\n`
  );

  // ── 4. Full denormalized snapshot ─────────────────────────────────────────
  console.log("📦 Writing full snapshot…");
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
  const snapshot = {
    harvested_at: now.toISOString(),
    games_count: games.length,
    players_count: players.length,
    stats_games_count: Object.keys(allStats).length,
    games,
    players,
    stats: allStats,
  };
  const snapPath = path.join(DATA_DIR, `snapshot_${timestamp}.json`);
  writeJSON(snapPath, snapshot);
  // Overwrite stable latest pointer
  fs.writeFileSync(path.join(DATA_DIR, "snapshot_latest.json"), JSON.stringify(snapshot, null, 2));
  console.log(`   → also wrote snapshot_latest.json\n`);

  console.log("═══════════════════════════════════════════════");
  console.log(`  Harvest complete: ${games.length} games | ${players.length} players`);
  console.log("═══════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
