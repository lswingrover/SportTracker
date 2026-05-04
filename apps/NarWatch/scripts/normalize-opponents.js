#!/usr/bin/env node
/**
 * NarWatch — Opponent Name Normalizer
 *
 * Reads data/opponent_normalization_map.json and rewrites games.json with two new fields:
 *   - opponent_id: canonical opponent slug (e.g. "hillsboro-wp")
 *   - opponent_display_name: human-readable canonical name (e.g. "Hillsboro WP")
 *   - opponent_ambiguous: true if the mapping was flagged as uncertain
 *   - opponent_unmapped: true if no mapping exists (raw value kept as-is)
 *
 * This is the prerequisite for H2H records and opponent-filtered leaderboards.
 * Run after any harvest that introduces new opponent name variants, then re-run
 * compute-aggregates.js so H2H aggregates use normalized opponent keys.
 *
 * Usage:
 *   node scripts/normalize-opponents.js            # write mode
 *   node scripts/normalize-opponents.js --dry-run  # preview only
 *   node scripts/normalize-opponents.js --report   # print unmapped list only
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../data");
const DRY_RUN  = process.argv.includes("--dry-run");
const REPORT   = process.argv.includes("--report");

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
  console.log("  NarWatch — Opponent Name Normalization       ");
  if (DRY_RUN) console.log("  MODE: DRY RUN — no files written            ");
  if (REPORT)  console.log("  MODE: REPORT — unmapped list only           ");
  console.log("═══════════════════════════════════════════════\n");

  const normMap        = readJSON("opponent_normalization_map.json");
  const rawToCanonical = normMap.raw_to_canonical;
  const canonicalById  = {};
  for (const o of normMap.canonical_opponents) canonicalById[o.id] = o;

  const games = readJSON("games.json");

  let mapped = 0, ambiguous = 0, unmapped = 0;
  const unmappedNames   = new Set();
  const ambiguousNames  = new Set();

  // ── If --report mode, just print unmapped and exit ─────────────────────────
  if (REPORT) {
    for (const game of games) {
      const raw = game.away_team;
      const entry = rawToCanonical[raw];
      if (!entry) unmappedNames.add(raw);
      else if (entry.ambiguous) ambiguousNames.add(raw);
    }
    if (unmappedNames.size === 0) {
      console.log("✓ All away_team values are mapped.\n");
    } else {
      console.log(`⚠  ${unmappedNames.size} unmapped away_team values:\n`);
      [...unmappedNames].sort().forEach(n => console.log(`  "${n}"`));
    }
    if (ambiguousNames.size > 0) {
      console.log(`\n⚡  ${ambiguousNames.size} ambiguous mappings (flagged):\n`);
      [...ambiguousNames].sort().forEach(n => {
        const entry = rawToCanonical[n];
        console.log(`  "${n}" → ${entry.canonical}  (${entry.note || ""})`);
      });
    }
    return;
  }

  // ── Normalize games.json ───────────────────────────────────────────────────
  const normalizedGames = games.map((game) => {
    const raw   = game.away_team;
    const entry = rawToCanonical[raw];

    if (!entry) {
      unmapped++;
      unmappedNames.add(raw);
      return {
        ...game,
        opponent_id:           null,
        opponent_display_name: raw,
        opponent_region:       null,
        opponent_ambiguous:    false,
        opponent_unmapped:     true,
      };
    }

    const canonical = canonicalById[entry.canonical];
    mapped++;
    if (entry.ambiguous) {
      ambiguous++;
      ambiguousNames.add(raw);
    }

    return {
      ...game,
      opponent_id:           entry.canonical,
      opponent_display_name: canonical?.display_name ?? entry.canonical,
      opponent_region:       canonical?.region ?? null,
      opponent_ambiguous:    entry.ambiguous ?? false,
      opponent_unmapped:     false,
    };
  });

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`Games: ${games.length} total`);
  console.log(`  → ${mapped} mapped (${ambiguous} flagged ambiguous)`);
  if (unmapped > 0) {
    console.log(`  → ⚠  ${unmapped} UNMAPPED:`);
    [...unmappedNames].sort().forEach(n => console.log(`       "${n}"`));
    console.log(`     Add these to opponent_normalization_map.json and re-run.`);
  } else {
    console.log(`  → ✓ All away_team values mapped`);
  }
  if (ambiguousNames.size > 0) {
    console.log(`\n  ⚡ Ambiguous mappings (review when possible):`);
    [...ambiguousNames].sort().forEach(n => {
      const entry = rawToCanonical[n];
      console.log(`       "${n}" → ${entry.canonical}`);
    });
  }
  console.log();

  writeJSON("games.json", normalizedGames);

  // ── H2H summary ────────────────────────────────────────────────────────────
  console.log("H2H summary after normalization:");
  const h2h = {};
  for (const g of normalizedGames) {
    const key = g.opponent_id ?? `[UNMAPPED] ${g.away_team}`;
    if (!h2h[key]) h2h[key] = { w: 0, l: 0, t: 0, display: g.opponent_display_name };
    // CDA is always the home_team in this dataset — us = home_score, them = away_score
    const us    = Number(g.home_score);
    const them  = Number(g.away_score);
    const hasScores = !isNaN(us) && !isNaN(them) &&
                      g.home_score !== null && g.home_score !== "" &&
                      g.away_score !== null && g.away_score !== "";
    if (!hasScores) continue;
    if (us > them) h2h[key].w++;
    else if (them > us) h2h[key].l++;
    else h2h[key].t++;
  }
  const h2hSorted = Object.entries(h2h)
    .map(([id, rec]) => ({ id, ...rec, total: rec.w + rec.l + rec.t }))
    .sort((a, b) => b.total - a.total);

  for (const { id, w, l, t, total, display } of h2hSorted) {
    const tag = id.startsWith("[UNMAPPED]") ? " ⚠" : "";
    console.log(`  ${String(total).padStart(3)} games  ${String(w).padStart(2)}W ${String(l).padStart(2)}L ${String(t).padStart(2)}T  ${display}${tag}`);
  }

  console.log("\n═══════════════════════════════════════════════");
  console.log("  Normalization complete. Now run:");
  console.log("  node scripts/compute-aggregates.js");
  console.log("═══════════════════════════════════════════════\n");
}

main();
