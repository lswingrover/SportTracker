// Push subscribe stub for NarWatch v1. Web Push will return when
// the project gets a Vercel Blob store + VAPID keys provisioned.
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  res.status(200).json({
    ok: false,
    reason: "Push notifications coming soon for NarWatch",
  });
}
