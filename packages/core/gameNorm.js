// Shared game normalization utilities used by both narwhaltracker and
// volleywatch. Extract-don't-duplicate: if you find yourself copying one
// of these functions into a new data source adapter, import from here instead.

// ─── deriveStandings ─────────────────────────────────────────────────────────
//
// Compute a standings table from a normalized game array.
//
// Input:
//   games    – array of normalized game objects ({ done, result, opponent, sets })
//   teamName – display name for "our" team, e.g. "North Idaho Narwhals"
//   teamId   – slug for "our" team, e.g. "narwhals"
//
// Output: array of standing rows sorted by matchesWon desc, goalDiff desc.
// Each row: { teamId, teamName, isUs, rank, matchesWon, matchesLost, goalDiff,
//             setPercent, earnedBid, bidAlias }
//
// Notes:
//   - Only games with done=true and a result ("W"/"L") are counted.
//   - sets is expected to be an array of { us, them } objects. Missing or
//     non-array sets is handled gracefully.

export function deriveStandings(games, teamName, teamId) {
  if (!games || games.length === 0) return [];
  const map = new Map();

  const ensure = (name, isUs) => {
    if (!map.has(name)) {
      map.set(name, {
        teamId:      isUs ? teamId : name.toLowerCase().replace(/\s+/g, "-"),
        teamName:    name,
        isUs,
        rank:        null,
        matchesWon:  0,
        matchesLost: 0,
        goalDiff:    0,
        setPercent:  0,
        earnedBid:   false,
        bidAlias:    null,
      });
    }
    return map.get(name);
  };

  for (const g of games) {
    if (!g.done || !g.result) continue;
    const us   = ensure(teamName, true);
    const them = ensure(g.opponent, false);
    if (g.result === "W") { us.matchesWon++;   them.matchesLost++; }
    else                  { us.matchesLost++;  them.matchesWon++;  }
    if (Array.isArray(g.sets)) {
      for (const s of g.sets) {
        us.goalDiff   += (s.us   || 0) - (s.them || 0);
        them.goalDiff += (s.them || 0) - (s.us   || 0);
      }
    }
  }

  const rows = Array.from(map.values()).sort((a, b) => {
    if (b.matchesWon !== a.matchesWon) return b.matchesWon - a.matchesWon;
    return b.goalDiff - a.goalDiff;
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
