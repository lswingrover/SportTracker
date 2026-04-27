import { removeSubscription, pushConfigured } from "../../lib/push.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (!pushConfigured()) return res.status(503).json({ error: "push_not_configured" });
  const { endpoint, teamId } = req.body || {};
  if (!endpoint || !teamId) return res.status(400).json({ error: "missing_fields" });
  const ok = await removeSubscription(String(teamId), endpoint);
  return res.status(ok ? 200 : 500).json({ ok });
}
