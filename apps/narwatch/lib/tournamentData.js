// Static tournament data for NarWatch. v1 has no live data source —
// the API reads from this file. Future versions can swap in a live data
// source (e.g., a water-polo scoring system) by replacing the lookup
// function or adding a `dataSource: "api"` branch in /api/tournament.

export const TOURNAMENTS = [
  {
    id: "bend-2026",
    label: "Cascade Classic",
    chipLabel: "Bend",
    shortLabel: "Bend",
    teamId: "narwhals",
    teamName: "North Idaho Narwhals",
    venue: {
      name: "Bend Aquatic Center",
      address: "Bend, OR",
      tz: "America/Los_Angeles",
    },
    date: "Apr 17–19, 2026",
    static: true,
    dataSource: "niwp",
    weekKey: "2026-W16",
  },
];

export function findTournament(tournamentId) {
  return TOURNAMENTS.find((t) => t.id === tournamentId) || null;
}

// Sum goal differential across all completed games in a tournament.
// games[] uses the same shape as the live data layer would: each game
// has { result: "W" | "L" | null, sets: [{ us, them, deciding? }, ...] }
// where `sets` for water polo represents quarters.
export function computeGoalDiff(games) {
  if (!Array.isArray(games)) return 0;
  let diff = 0;
  for (const g of games) {
    if (!g.done || !Array.isArray(g.sets)) continue;
    for (const s of g.sets) {
      if (typeof s.us === "number" && typeof s.them === "number") {
        diff += s.us - s.them;
      }
    }
  }
  return diff;
}
