// NarWatch push subscription API.
//
// POST  /api/push-subscribe  — register or update a push subscription
// DELETE /api/push-subscribe — unregister a subscription
//
// Request body (POST):
//   { subscription: PushSubscription, teamId?: string, prefs?: object, ua?: string }
//
// Response:
//   { ok: true }  — subscription stored
//   { ok: false, reason: string, configured: false }  — infra not provisioned
//
// Requires:
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT  env vars
//   Vercel Blob store  (BLOB_READ_WRITE_TOKEN env var)

import {
  addSubscription,
  removeSubscription,
  pushConfigured,
} from "@sport-tracker/core/push.js";

const DEFAULT_TEAM_ID = "narwhals";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  // ── DELETE: unsubscribe ───────────────────────────────────────────────────
  if (req.method === "DELETE") {
    const { endpoint, teamId } = req.body || {};
    if (!endpoint) return res.status(400).json({ ok: false, reason: "missing endpoint" });
    try {
      await removeSubscription(teamId || DEFAULT_TEAM_ID, endpoint);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[push-subscribe] remove error:", err.message);
      return res.status(500).json({ ok: false, reason: "internal error" });
    }
  }

  // ── POST: subscribe ───────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "method not allowed" });
  }

  // Surface configuration state so the client can show a helpful message.
  if (!pushConfigured()) {
    return res.status(200).json({
      ok: false,
      configured: false,
      reason: "Push notifications not yet provisioned on this deployment. " +
        "Add NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, " +
        "and a Vercel Blob store (BLOB_READ_WRITE_TOKEN) to enable them.",
    });
  }

  const { subscription, teamId, prefs, ua } = req.body || {};

  if (!subscription?.endpoint) {
    return res.status(400).json({ ok: false, reason: "missing subscription.endpoint" });
  }

  try {
    const ok = await addSubscription(
      teamId || DEFAULT_TEAM_ID,
      subscription,
      ua || req.headers["user-agent"] || "",
      prefs
    );
    return res.status(200).json({ ok: Boolean(ok), configured: true });
  } catch (err) {
    console.error("[push-subscribe] add error:", err.message);
    return res.status(500).json({ ok: false, reason: "internal error" });
  }
}
