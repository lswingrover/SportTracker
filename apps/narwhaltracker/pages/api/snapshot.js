// Fetch a specific tournament snapshot by timestamp.
//   ?ts=latest    → most recent non-terminal snapshot (default)
//   ?ts=terminal  → the terminal (final) snapshot, if one exists
//   ?ts=<isoLike> → exact match against the snapshot pathname

import { getSnapshot } from "../../lib/snapshots.js";

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
  const ts = String(req.query?.ts || "latest");
  const snap = await getSnapshot(eventId, ts);
  if (!snap) return res.status(404).json({ error: "snapshot_not_found", eventId, ts });
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
  res.status(200).json(snap);
}
