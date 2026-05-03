#!/usr/bin/env node
/**
 * NarWatch — Aggregate Computations
 *
 * Reads raw data/ files and produces:
 *   player_season_stats.json   — per-player totals across all games
 *   team_record.json           — per-team W/L record, goals, by-opponent, by-tournament
 *   tournament_summary.json    — per-tournament results and team records
 *   meta.json                  — index of what was computed
 *
 * Game shape:
 *   { game_id, home_team, away_team, location, game_date, home_score, away_score }
 *
 * Stat shape (per row in stats_<id>.json):
 *   { stat_id, game_id, player_id, player_name, cap_number,
 *     goals, assists, steals, blocks, kickouts }
 *
 * Player shape:
 *   { player_id, player_name, default_cap }
 *
 * NOTE: player_name prefix convention: "B - Name" = Boys, "G - Name" = Girls,
 *       "X - Name" = Co-Ed/Unknown, etc.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../data");

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`  ✗ Failed to read ${filePath}: ${e.message}`);
    return null;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  const bytes = Buffer.byteLength(JSON.stringify(data));
  const count = Array.isArray(data) ? ` (${data.length} items)` : "";
  console.log(`  ✓ ${path.basename(filePath)} — ${bytes.toLocaleString()} bytes${count}`);
}

function n(v) {
  const x = Number(v);
  return isNaN(x) ? 0 : x;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// Extract CDA team, opponent, result from a game row
// home_team is always the CDA/local team; away_team is the opponent
function parseGame(game) {
  const homeScore = n(game.home_score);
  const awayScore = n(game.away_score);
  return {
    gameId: game.game_id,
    homeTeam: game.home_team,   // e.g. "CDA 18U Boys"
    awayTeam: game.away_team,   // opponent
    location: game.location,    // tournament/location
    date: game.game_date,
    homeScore,
    awayScore,
    homeWon: homeScore > awayScore,
    awayWon: awayScore > homeScore,
    tied: homeScore === awayScore,
  };
}

// Group games by tournament (location field)
function getTournament(game) {
  return game.location?.trim() || "Unknown";
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  NarWatch — Computing Aggregates              ");
  console.log("═══════════════════════════════════════════════\n");

  // ── Load raw data ─────────────────────────────────────────────────────────
  const games = readJSON(path.join(DATA_DIR, "games.json")) ?? [];
  const players = readJSON(path.join(DATA_DIR, "players.json")) ?? [];

  if (!games.length) {
    console.error("❌ No games.json found — run harvest-niwp.js first.");
    process.exit(1);
  }
  console.log(`Loaded: ${games.length} games, ${players.length} players`);

  // Collect all stats files
  const statsFiles = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("stats_") && f.endsWith(".json"));

  const statsByGame = {};
  for (const f of statsFiles) {
    const gameId = f.replace("stats_", "").replace(".json", "");
    const stats = readJSON(path.join(DATA_DIR, f));
    if (Array.isArray(stats) && stats.length > 0) {
      statsByGame[gameId] = stats;
    }
  }
  console.log(`Loaded stats for ${Object.keys(statsByGame).length} / ${games.length} games\n`);

  // Player lookup by player_id
  const playerById = {};
  for (const p of players) {
    playerById[String(p.player_id)] = p;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 1. player_season_stats.json
  // ────────────────────────────────────────────────────────────────────────
  console.log("Computing player_season_stats.json…");

  // Build game result lookup: game_id → { homeTeam, homeWon, awayWon, tied }
  const gameResultByID = {};
  for (const game of games) {
    gameResultByID[String(game.game_id)] = parseGame(game);
  }

  // Accumulate per-player stats
  const playerAccum = {}; // player_id → totals

  function ensurePlayer(pid, name, cap) {
    if (!playerAccum[pid]) {
      playerAccum[pid] = {
        player_id: pid,
        player_name: name,
        cap_number: cap,
        goals: 0,
        assists: 0,
        steals: 0,
        blocks: 0,
        kickouts: 0,
        games_played: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        teams_played_for: new Set(),
      };
    }
    return playerAccum[pid];
  }

  for (const [gameId, statRows] of Object.entries(statsByGame)) {
    const gr = gameResultByID[gameId];
    if (!gr) continue;

    for (const stat of statRows) {
      const pid = String(stat.player_id);
      const acc = ensurePlayer(pid, stat.player_name, stat.cap_number);

      acc.goals += n(stat.goals);
      acc.assists += n(stat.assists);
      acc.steals += n(stat.steals);
      acc.blocks += n(stat.blocks);
      acc.kickouts += n(stat.kickouts);
      acc.games_played++;

      // Determine win/loss: stats are for home_team players
      // We don't know if this player played for home or away from the stat alone,
      // but player_name prefix (B/G/X) doesn't tell us team directly.
      // Use: the home_team of the game — all players in a game's stats belong to home_team.
      if (gr.homeWon) acc.wins++;
      else if (gr.awayWon) acc.losses++;
      else acc.ties++;

      acc.teams_played_for.add(gr.homeTeam);
    }
  }

  const playerSeasonStats = Object.values(playerAccum).map((acc) => {
    const master = playerById[String(acc.player_id)];
    const gp = acc.games_played;
    return {
      player_id: acc.player_id,
      player_name: acc.player_name || master?.player_name || `Player ${acc.player_id}`,
      cap_number: acc.cap_number ?? master?.default_cap ?? null,
      games_played: gp,
      wins: acc.wins,
      losses: acc.losses,
      ties: acc.ties,
      win_pct: gp ? round3(acc.wins / gp) : 0,
      goals: acc.goals,
      assists: acc.assists,
      steals: acc.steals,
      blocks: acc.blocks,
      kickouts: acc.kickouts,
      avg_goals_per_game: gp ? round2(acc.goals / gp) : 0,
      avg_assists_per_game: gp ? round2(acc.assists / gp) : 0,
      teams: [...acc.teams_played_for].sort(),
    };
  });

  playerSeasonStats.sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.player_name.localeCompare(b.player_name));

  writeJSON(path.join(DATA_DIR, "player_season_stats.json"), playerSeasonStats);
  console.log(`   → ${playerSeasonStats.length} players with stats\n`);

  // ────────────────────────────────────────────────────────────────────────
  // 2. team_record.json  (per CDA team — home_team)
  // ────────────────────────────────────────────────────────────────────────
  console.log("Computing team_record.json…");

  const teamMap = {}; // team_name → record

  function ensureTeam(name) {
    if (!teamMap[name]) {
      teamMap[name] = {
        team: name,
        wins: 0, losses: 0, ties: 0, games: 0,
        goals_for: 0, goals_against: 0,
        by_opponent: {},
        by_tournament: {},
      };
    }
    return teamMap[name];
  }

  for (const game of games) {
    const g = parseGame(game);
    const tm = ensureTeam(g.homeTeam);
    const tournament = getTournament(game);

    tm.games++;
    tm.goals_for += g.homeScore;
    tm.goals_against += g.awayScore;
    if (g.homeWon) tm.wins++;
    else if (g.awayWon) tm.losses++;
    else tm.ties++;

    // by_opponent
    if (!tm.by_opponent[g.awayTeam]) {
      tm.by_opponent[g.awayTeam] = { opponent: g.awayTeam, wins: 0, losses: 0, ties: 0, games: 0, goals_for: 0, goals_against: 0 };
    }
    const opp = tm.by_opponent[g.awayTeam];
    opp.games++;
    opp.goals_for += g.homeScore;
    opp.goals_against += g.awayScore;
    if (g.homeWon) opp.wins++;
    else if (g.awayWon) opp.losses++;
    else opp.ties++;

    // by_tournament
    if (!tm.by_tournament[tournament]) {
      tm.by_tournament[tournament] = { tournament, wins: 0, losses: 0, ties: 0, games: 0, goals_for: 0, goals_against: 0 };
    }
    const t = tm.by_tournament[tournament];
    t.games++;
    t.goals_for += g.homeScore;
    t.goals_against += g.awayScore;
    if (g.homeWon) t.wins++;
    else if (g.awayWon) t.losses++;
    else t.ties++;
  }

  // Finalize team records
  const teamRecord = {
    computed_at: new Date().toISOString(),
    teams: Object.values(teamMap).map((tm) => ({
      team: tm.team,
      games: tm.games,
      wins: tm.wins,
      losses: tm.losses,
      ties: tm.ties,
      win_pct: tm.games ? round3(tm.wins / tm.games) : 0,
      goals_for: tm.goals_for,
      goals_against: tm.goals_against,
      goal_differential: tm.goals_for - tm.goals_against,
      avg_goals_for: tm.games ? round2(tm.goals_for / tm.games) : 0,
      avg_goals_against: tm.games ? round2(tm.goals_against / tm.games) : 0,
      record_str: `${tm.wins}-${tm.losses}${tm.ties ? `-${tm.ties}` : ""}`,
      by_opponent: Object.values(tm.by_opponent).sort((a, b) => b.games - a.games),
      by_tournament: Object.values(tm.by_tournament).sort((a, b) => b.games - a.games),
    })).sort((a, b) => b.games - a.games),
  };

  // Add combined totals across all CDA teams
  const totals = teamRecord.teams.reduce(
    (acc, t) => {
      acc.games += t.games;
      acc.wins += t.wins;
      acc.losses += t.losses;
      acc.ties += t.ties;
      acc.goals_for += t.goals_for;
      acc.goals_against += t.goals_against;
      return acc;
    },
    { games: 0, wins: 0, losses: 0, ties: 0, goals_for: 0, goals_against: 0 }
  );
  teamRecord.combined = {
    ...totals,
    win_pct: totals.games ? round3(totals.wins / totals.games) : 0,
    goal_differential: totals.goals_for - totals.goals_against,
    record_str: `${totals.wins}-${totals.losses}${totals.ties ? `-${totals.ties}` : ""}`,
  };

  writeJSON(path.join(DATA_DIR, "team_record.json"), teamRecord);
  const c = teamRecord.combined;
  console.log(`   → ${teamRecord.teams.length} teams | Combined: ${c.record_str} (${c.goals_for} GF / ${c.goals_against} GA)\n`);

  // ────────────────────────────────────────────────────────────────────────
  // 3. tournament_summary.json
  // ────────────────────────────────────────────────────────────────────────
  console.log("Computing tournament_summary.json…");

  const tournMap = {};

  for (const game of games) {
    const g = parseGame(game);
    const key = getTournament(game);

    if (!tournMap[key]) {
      tournMap[key] = {
        tournament: key,
        wins: 0, losses: 0, ties: 0, games: 0,
        goals_for: 0, goals_against: 0,
        teams: new Set(),
        opponents: new Set(),
        game_log: [],
      };
    }
    const t = tournMap[key];
    t.games++;
    t.goals_for += g.homeScore;
    t.goals_against += g.awayScore;
    t.teams.add(g.homeTeam);
    t.opponents.add(g.awayTeam);
    if (g.homeWon) t.wins++;
    else if (g.awayWon) t.losses++;
    else t.ties++;

    t.game_log.push({
      game_id: g.gameId,
      date: g.date,
      home_team: g.homeTeam,
      away_team: g.awayTeam,
      home_score: g.homeScore,
      away_score: g.awayScore,
      result: g.homeWon ? "W" : g.awayWon ? "L" : "T",
    });
  }

  const tournamentSummary = Object.values(tournMap).map((t) => {
    t.game_log.sort((a, b) => (a.date < b.date ? -1 : 1));
    return {
      tournament: t.tournament,
      games_played: t.games,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      win_pct: t.games ? round3(t.wins / t.games) : 0,
      record_str: `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`,
      goals_for: t.goals_for,
      goals_against: t.goals_against,
      goal_differential: t.goals_for - t.goals_against,
      cda_teams: [...t.teams].sort(),
      opponents: [...t.opponents].sort(),
      game_log: t.game_log,
    };
  });

  tournamentSummary.sort((a, b) => b.games_played - a.games_played);
  writeJSON(path.join(DATA_DIR, "tournament_summary.json"), tournamentSummary);
  console.log(`   → ${tournamentSummary.length} tournaments/locations\n`);

  // ── Meta index ────────────────────────────────────────────────────────────
  const meta = {
    computed_at: new Date().toISOString(),
    games_total: games.length,
    games_with_stats: Object.keys(statsByGame).length,
    players_total: players.length,
    players_with_stats: playerSeasonStats.length,
    teams: teamRecord.teams.map((t) => t.team),
    tournaments: tournamentSummary.length,
    combined_record: teamRecord.combined.record_str,
    combined_goals_for: teamRecord.combined.goals_for,
    combined_goals_against: teamRecord.combined.goals_against,
  };
  writeJSON(path.join(DATA_DIR, "meta.json"), meta);

  console.log("\n═══════════════════════════════════════════════");
  console.log("  Aggregates complete");
  console.log("═══════════════════════════════════════════════\n");
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
