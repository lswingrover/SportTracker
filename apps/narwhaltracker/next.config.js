/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sport-tracker/core'],

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
