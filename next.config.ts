import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This project is nested inside the ecom app, which has its own lockfile and
  // middleware. Pin the workspace root here so Next doesn't pick up the parent's
  // src/middleware.js (which imports tenant config that doesn't exist in this app).
  turbopack: {
    root: __dirname,
  },
};

export default withMDX(nextConfig);
