import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },

  // Pin the workspace root. Without this, an unrelated lockfile in a parent
  // directory makes Next guess wrong and warn on every start.
  outputFileTracingRoot: path.resolve(import.meta.dirname),

  // `next dev` and `next build` share .next, and mixing their artifacts breaks
  // the dev asset pipeline (the symptom is a page that renders with no CSS).
  // The verification suite therefore builds into its own directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
