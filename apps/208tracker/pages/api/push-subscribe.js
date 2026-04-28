import { addSubscription, pushConfigured } from "@sport-tracker/core/push.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (!pushConfigured()) {
    return res.status(503).json({ error: "push_not_configured" });
  }

  const { subscription, teamId, prefs } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "invalid_subscription" });
  }
  if (!teamId) return res.status(400).json({ error: "missing_teamId" });

  const ok = await addSubscription(
    String(teamId),
    subscription,
    req.headers["user-agent"],
    prefs
  );
  if (!ok) return res.status(500).json({ error: "store_write_failed" });
  return res.status(200).json({ ok: true });
}
