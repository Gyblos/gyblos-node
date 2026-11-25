import { PAGES, STATS } from './constants';

export function hashTarget(hash: string): string | null {
  try {
    return decodeURIComponent(hash.replace(/^#/, '')) || null;
  } catch {
    return null;
  }
}

export function pageScrollTarget(url: URL, inPlaceHref: string | null) {
  if (url.href === inPlaceHref) return null;
  const tab =
    url.pathname === PAGES.stats ? url.searchParams.get(STATS.tabParam) : null;
  return hashTarget(url.hash) ?? STATS.tabs.find((section) => section === tab);
}
