// List tournament snapshots (most recent first) plus the terminal one
// if it exists. Frontend uses this to discover what longitudinal data
// is available before requesting an individual snapshot via /api/snapshot.

import { listSnapshots } from "@sport-tracker/core/snapshots.js";

// Mirror of the client TOURNAMENTS config so callers can pass either
// `eventId=...` (canonical AES key) or `tournamentId=...` (the local
// human-friendly id) and we resolve to the same underlying blob folder.
const TOURNAMENT_TO_EVENT = {
  "big-sky-volleyfest-2026": "PTAwMDAwNDI5NjU90",
  "erva-regional-2026": "PTAwMDAwNDI2MDU90",
  "mt-nw-jamboree-2026": "PTAwMDAwNDQ5NzY90",
  "erva-power-league-2026": "PTAwMDAwNDI2MDY90",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const eventId =
    String(req.query?.eventId || "") ||
    TOURNAMENT_TO_EVENT[String(req.query?.tournamentId || "")];
  if (!eventId) return res.status(400).json({ error: "missing_eventId_or_tournamentId" });
  const result = await listSnapshots(eventId);
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
  res.status(200).json({ eventId, ...result });
}
