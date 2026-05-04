/** @type {import('next').NextConfig} */

const CANONICAL_ORIGIN = "https://narwatch.vercel.app";

// All non-canonical hostnames that should 308 → narwatch.vercel.app:
//   narwatch-<hash>-lswingrovers-projects.vercel.app  (per-deployment hash URLs)
//   narwatch-lswingrovers-projects.vercel.app          (team auto-alias)
//   narwhaltracker.vercel.app                          (old project domain)
//   narwhaltracker-gamma.vercel.app                    (old project domain)
//   narwhaltracker-*.vercel.app                        (old project hash deploys)
// Does NOT match narwatch.vercel.app (canonical).
// NOTE: Must include "lswingrovers-projects" to avoid matching the canonical
//       narwatch.vercel.app itself (narwatch-app matches narwatch-.+ too).
const NON_CANONICAL_HOSTS = [
  "narwatch-.+-lswingrovers-projects\\.vercel\\.app",
  "narwhaltracker\\.vercel\\.app",
  "narwhaltracker-.+\\.vercel\\.app",
  "narwhaltracker-gamma\\.vercel\\.app",
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sport-tracker/core'],

  async redirects() {
    return NON_CANONICAL_HOSTS.map((hostPattern) => ({
      source: "/:path*",
      has: [{ type: "host", value: hostPattern }],
      destination: `${CANONICAL_ORIGIN}/:path*`,
      permanent: true,
    }));
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
