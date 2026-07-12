/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the production Docker image small — only the
  // traced dependency subset gets copied in, not the full node_modules.
  output: "standalone",
};

module.exports = nextConfig;
