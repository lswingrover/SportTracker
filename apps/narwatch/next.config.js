/** @type {import('next').NextConfig} */

const CANONICAL_ORIGIN = "https://narwatch.vercel.app";

// Matches any Vercel-generated non-canonical hostname for this project:
//   narwatch-<hash>-lswingrovers-projects.vercel.app  (per-deployment)
//   narwatch-lswingrovers-projects.vercel.app          (team auto-alias)
// Does NOT match narwatch.vercel.app (canonical — no hyphen after "narwatch").
const NON_CANONICAL_HOST_PATTERN = "narwatch-.+\\.vercel\\.app";

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sport-tracker/core'],

  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: NON_CANONICAL_HOST_PATTERN }],
        destination: `${CANONICAL_ORIGIN}/:path*`,
        permanent: true,
      },
    ];
  },

  // Prevent CDN and browsers from caching the HTML document shell.
  // Static assets (JS/CSS chunks) still get their normal long-lived cache
  // via content-hash filenames — this only affects the HTML entry point.
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
