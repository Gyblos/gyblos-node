// Lets search engines and AI search/user crawlers read the explorer and points them at its sitemap,
// the same public-content policy as the website's robots.txt.
import type { MetadataRoute } from 'next';

import { SITE } from '../lib/site';

const CRAWLERS = [
  '*',
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: CRAWLERS.map((userAgent) => ({ userAgent, allow: '/' })),
    sitemap: `${SITE.origin}/sitemap.xml`,
    host: SITE.origin,
  };
}
