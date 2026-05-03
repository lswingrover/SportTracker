#!/usr/bin/env node
/**
 * NarWatch — Team Name Normalizer
 *
 * Reads data/team_normalization_map.json and rewrites games.json with two new fields:
 *   - team_id: canonical team ID (e.g. "cda-18u-boys")
 *   - team_ambiguous: true if the mapping was flagged as uncertain
 *
 * Also patches snapshot_latest.json with the same enrichment.
 *
 * Run this after any harvest that produces new team name variants, then re-run
 * compute-aggregates.js so all aggregates use normalized keys.
 *
 * Usage: node scripts/normalize-teams.js [--dry-run]
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../data");
const DRY_RUN = process.argv.includes("--dry-run");

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
}

function writeJSON(file, data) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would write ${file}`);
    return;
  }
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
  console.log(`  ✓ ${file}`);
}

function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  NarWatch — Team Name Normalization           ");
  if (DRY_RUN) console.log("  MODE: DRY RUN — no files written            ");
  console.log("═══════════════════════════════════════════════\n");

  const normMap = readJSON("team_normalization_map.json");
  const rawToCanonical = normMap.raw_to_canonical;
  const canonicalTeams = normMap.canonical_teams;

  // Build canonical team lookup by id
  const canonicalById = {};
  for (const t of canonicalTeams) canonicalById[t.id] = t;

  // ── Normalize games ───────────────────────────────────────────────────────
  const games = readJSON("games.json");

  let mapped = 0, ambiguous = 0, unmapped = 0;
  const unmappedNames = new Set();

  const normalizedGames = games.map((game) => {
    const raw = game.home_team;
    const entry = rawToCanonical[raw];

    if (!entry) {
      unmapped++;
      unmappedNames.add(raw);
      return {
        ...game,
        team_id: null,
        team_display_name: raw,
        team_ambiguous: false,
        team_unmapped: true,
      };
    }

    const canonical = canonicalById[entry.canonical];
    mapped++;
    if (entry.ambiguous) ambiguous++;

    return {
      ...game,
      team_id: entry.canonical,
      team_display_name: canonical?.display_name ?? entry.canonical,
      team_short: canonical?.short ?? entry.canonical,
      team_type: canonical?.type ?? "competitive",
      team_ambiguous: entry.ambiguous ?? false,
      team_unmapped: false,
    };
  });

  console.log(`Games: ${games.length} total`);
  console.log(`  → ${mapped} mapped (${ambiguous} ambiguous)`);
  if (unmapped > 0) {
    console.log(`  → ⚠ ${unmapped} UNMAPPED: ${[...unmappedNames].join(", ")}`);
    console.log(`     Add these to team_normalization_map.json and re-run.`);
  } else {
    console.log(`  → ✓ All games mapped`);
  }
  console.log();

  writeJSON("games.json", normalizedGames);

  // ── Stats: annotate each stat row with the game's team_id ─────────────────
  console.log("Annotating stat files…");
  const gameById = {};
  for (const g of normalizedGames) gameById[String(g.game_id)] = g;

  const statsFiles = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("stats_") && f.endsWith(".json"));

  let statsPatched = 0;
  for (const file of statsFiles) {
    const stats = readJSON(file);
    if (!Array.isArray(stats) || stats.length === 0) continue;
    const gameId = file.replace("stats_", "").replace(".json", "");
    const game = gameById[gameId];
    if (!game) continue;

    const patched = stats.map((row) => ({
      ...row,
      team_id: game.team_id,
      team_display_name: game.team_display_name,
    }));

    writeJSON(file, patched);
    statsPatched++;
  }
  console.log(`  → ${statsPatched} stat files annotated\n`);

  // ── Print team summary ────────────────────────────────────────────────────
  console.log("Team summary after normalization:");
  const teamCounts = {};
  for (const g of normalizedGames) {
    const key = g.team_id ?? `[UNMAPPED] ${g.home_team}`;
    teamCounts[key] = (teamCounts[key] ?? 0) + 1;
  }
  const sorted = Object.entries(teamCounts).sort((a, b) => b[1] - a[1]);
  for (const [teamId, count] of sorted) {
    const canonical = canonicalById[teamId];
    const label = canonical ? `${canonical.display_name} (${canonical.type})` : teamId;
    const flag = canonical?.type === "exhibition" ? " 🎭" : "";
    const ambFlag = rawToCanonical[teamId]?.ambiguous ? " ⚠️ ambiguous" : "";
    console.log(`  ${String(count).padStart(3)} games  ${label}${flag}${ambFlag}`);
  }

  console.log("\n═══════════════════════════════════════════════");
  console.log("  Normalization complete. Now run:");
  console.log("  node scripts/compute-aggregates.js");
  console.log("═══════════════════════════════════════════════\n");
}

main();
