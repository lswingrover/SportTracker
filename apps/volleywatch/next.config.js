/** @type {import('next').NextConfig} */

const CANONICAL_ORIGIN = "https://volleywatch-app.vercel.app";
const NON_CANONICAL_HOSTS = [
  "volleywatch-app-lswingrovers-projects.vercel.app",
  "volleywatch-lswingrovers-projects.vercel.app",
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
