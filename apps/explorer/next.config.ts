// Builds the metrics explorer: a server-rendered Next.js app over public, read-only sources
// (discovery index, metrics collector), rendered per request on Cloudflare Workers (OpenNext).
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
};

export default config;
