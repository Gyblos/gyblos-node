// Builds the metrics explorer: a server-rendered Next.js app over public, read-only sources
// (discovery index, metrics collector, Solana RPC). Cache Components keep each source's own cache life.
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  cacheComponents: true,
};

export default config;
