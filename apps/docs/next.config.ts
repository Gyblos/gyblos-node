// Builds the docs as a static site in out/ (no server): Cloudflare serves it, wrangler.jsonc.
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  // app/global-not-found.tsx becomes out/404.html, themed and in both languages.
  experimental: { globalNotFound: true },
};

export default createMDX()(config);
