// Builds the explorer for Cloudflare Workers (OpenNext). The page renders per request (no incremental
// cache is needed); every source is public, so the Worker holds no secrets.
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({});
