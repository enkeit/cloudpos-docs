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
  // The org's GitHub app only allows the old workers.dev callback URL, so the
  // Keystatic editor keeps running there; docs.cloudposai.com sends editors over.
  async redirects() {
    const editor = "https://cloudpos-docs.enkedevelopment-427.workers.dev";
    return [
      { source: "/keystatic", destination: `${editor}/keystatic`, permanent: false },
      { source: "/keystatic/:path+", destination: `${editor}/keystatic/:path+`, permanent: false },
    ];
  },
};

export default withMDX(nextConfig);
