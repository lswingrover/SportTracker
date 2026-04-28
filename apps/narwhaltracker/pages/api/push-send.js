// Internal/admin trigger to manually push to a team. Useful for testing
// from the browser; production state-diff pushes are emitted from
// /api/tournament directly via lib/push.js without going through HTTP.

import { pushToTeam, pushConfigured } from "../../lib/push.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (!pushConfigured()) return res.status(503).json({ error: "push_not_configured" });

  const { teamId, payload } = req.body || {};
  if (!teamId) return res.status(400).json({ error: "missing_teamId" });
  const safe = {
    title: String(payload?.title || "Narwhal Tracker").slice(0, 100),
    body: String(payload?.body || "").slice(0, 300),
    tag: payload?.tag ? String(payload.tag).slice(0, 80) : undefined,
    url: payload?.url ? String(payload.url).slice(0, 500) : undefined,
  };
  const result = await pushToTeam(String(teamId), safe);
  return res.status(200).json(result);
}
