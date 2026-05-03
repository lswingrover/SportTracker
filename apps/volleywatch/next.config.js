/** @type {import('next').NextConfig} */

const CANONICAL_ORIGIN = "https://volleywatch-app.vercel.app";

// Matches any Vercel-generated non-canonical hostname for this project:
//   volleywatch-app-<hash>-lswingrovers-projects.vercel.app  (per-deployment)
//   volleywatch-app-lswingrovers-projects.vercel.app          (team auto-alias)
//   volleywatch-<hash>-lswingrovers-projects.vercel.app       (alternate project name variant)
//   volleywatch-lswingrovers-projects.vercel.app
// Does NOT match volleywatch-app.vercel.app (canonical).
// NOTE: Must include "lswingrovers-projects" to avoid matching the canonical
//       volleywatch-app.vercel.app itself (the -app part satisfies .+ too).
const NON_CANONICAL_HOST_PATTERN = "volleywatch-.+-lswingrovers-projects\\.vercel\\.app";

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
