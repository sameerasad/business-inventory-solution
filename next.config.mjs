import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // Pin the workspace root. Without this, an unrelated lockfile in a parent
  // directory makes Next guess wrong and warn on every start.
  outputFileTracingRoot: path.resolve(import.meta.dirname),
};

export default nextConfig;
