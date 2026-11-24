import type { Metadata } from 'next';

import { SITE } from './site';

export function pageMetadata(
  name: string,
  path: string,
  description: string,
): Metadata {
  const title = `${name} · ${SITE.name}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', url: path, title, description },
    twitter: { title, description },
  };
}
