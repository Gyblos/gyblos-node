import { controlAddress } from '@gyblos/protocol/control-validation';

import type { GithubAccount } from './network-status';

export function addressLookup(value: string): string | null {
  try {
    return controlAddress(value);
  } catch {
    return null;
  }
}

export function searchPageHref(term: string, page: number) {
  const params = new URLSearchParams({ q: term });
  if (page > 1) params.set('page', String(page));
  return `/search?${params}`;
}

export function sellerMatches(
  seller: {
    nodeId: string;
    owner?: string;
    name?: string | null;
    github?: GithubAccount | null;
  },
  term: string,
) {
  const lower = term.toLowerCase();
  const account = seller.github?.account.toLowerCase();
  if (lower.startsWith('@'))
    return lower.length > 1 && !!account?.includes(lower.slice(1));
  return !!(
    seller.nodeId.includes(lower) ||
    account?.includes(lower) ||
    seller.name?.toLowerCase().includes(lower) ||
    seller.owner?.includes(term)
  );
}
