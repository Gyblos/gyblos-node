import type { MetadataRoute } from 'next';

import { PAGES } from '../lib/constants';
import { SITE } from '../lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return Object.values(PAGES).map((path) => ({
    url: `${SITE.origin}${path}`,
    changeFrequency: 'hourly',
    priority: path === PAGES.network ? 1 : SITE.pagePriority,
  }));
}
