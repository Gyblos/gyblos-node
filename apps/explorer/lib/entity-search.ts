import { controlAddress } from '@gyblos/protocol/control-validation';
import {
  MODEL_IDENTITY_SOURCE,
  modelIdentity,
} from '@gyblos/protocol/model-family';

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

export function modelMatches(
  model: {
    modelId: string;
    variant?: string | null;
    quantization?: string | null;
  },
  term: string,
) {
  const lower = term.toLowerCase();
  const identity = modelIdentity(model.modelId);
  const lab =
    identity.source === MODEL_IDENTITY_SOURCE.RULES ? identity.lab : undefined;
  return [model.modelId, lab, model.variant, model.quantization].some((value) =>
    value?.toLowerCase().includes(lower),
  );
}
