// Lists the explorer's one canonical page; range variants (?range=) canonicalize to it.
import type { MetadataRoute } from 'next';

import { SITE } from '../lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE.origin}/`, changeFrequency: 'hourly', priority: 1 }];
}
