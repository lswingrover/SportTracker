/** @type {import('next').NextConfig} */

const CANONICAL_ORIGIN = "https://narwatch.vercel.app";
const NON_CANONICAL_HOSTS = [
  "narwatch-lswingrovers-projects.vercel.app",
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sport-tracker/core'],

  async redirects() {
    return NON_CANONICAL_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host", value: host }],
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
