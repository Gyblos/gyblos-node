// Binds a quote decision to an exact v1 request body before forwarding to the trusted seller.
// A payment header freezes routing: no re-selection, conversion to v1, or retry after authorization.
import { createHash } from 'node:crypto';

import type { SellerSelectionCode } from '@gyblos/core/constants';

import { BUYER_SELECTION, BUYER_SELECTION_CODES } from './constants.js';
import type { requireLegacyQuoteCompatibility } from './selection-v1.js';
import type { SelectionDecision } from './selection.js';

export type ProxySelectionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | SellerSelectionCode
        | (typeof BUYER_SELECTION_CODES)[keyof typeof BUYER_SELECTION_CODES];
      cooldownUntil?: number;
    };
export interface ProxySelection {
  authorizationUncertain(): void;
  admit(
    body: Uint8Array,
    authorized: boolean,
    signal: AbortSignal,
  ): Promise<ProxySelectionResult>;
}
interface Decision {
  digest: string;
  expiresAt: number;
  authorized: boolean;
  identity: { owner: string; nodeId: string };
}
export function createProxySelection(
  quote: (
    signal: AbortSignal,
  ) => Promise<
    SelectionDecision | ReturnType<typeof requireLegacyQuoteCompatibility>
  >,
  maxTokens: number,
  now: () => number = Date.now,
  verifyIdentity?: (
    identity: { owner: string; nodeId: string },
    signal: AbortSignal,
  ) => Promise<boolean>,
): ProxySelection {
  const decisions = new Map<string, Decision>();
  let uncertain = false;
  return {
    authorizationUncertain() {
      uncertain = true;
    },
    async admit(body, authorized, signal) {
      if (uncertain)
        return { ok: false, code: BUYER_SELECTION_CODES.RECONCILE };
      const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('requestId' in parsed) ||
        typeof parsed.requestId !== 'string' ||
        !parsed.requestId ||
        parsed.requestId.length > BUYER_SELECTION.requestIdCharacters ||
        !('maxTokens' in parsed) ||
        parsed.maxTokens !== maxTokens
      )
        return { ok: false, code: BUYER_SELECTION_CODES.INVALID };
      const id = parsed.requestId;
      const digest = createHash('sha256').update(body).digest('hex');
      const prior = decisions.get(id);
      if (prior?.authorized)
        return { ok: false, code: BUYER_SELECTION_CODES.RECONCILE };
      if (authorized) {
        if (!prior || prior.digest !== digest || prior.expiresAt <= now()) {
          uncertain = true;
          return { ok: false, code: BUYER_SELECTION_CODES.RECONCILE };
        }
        if (!(await authorizeIdentity(prior, signal, now, verifyIdentity))) {
          uncertain = true;
          return { ok: false, code: BUYER_SELECTION_CODES.RECONCILE };
        }
        return { ok: true };
      }
      if (prior && prior.digest !== digest)
        return {
          ok: false,
          code: BUYER_SELECTION_CODES.AUTHORIZATION_REQUIRED,
        };
      if (prior && prior.expiresAt > now()) return { ok: true };
      for (const [key, value] of decisions)
        if (!value.authorized && value.expiresAt <= now())
          decisions.delete(key);
      if (decisions.size >= BUYER_SELECTION.maxDecisions)
        return { ok: false, code: BUYER_SELECTION_CODES.LIMIT };
      const result = await quote(signal);
      if (!result.ok) return result;
      if (signal.aborted || result.winner.quote.offer.expiresAt <= now())
        return { ok: false, code: BUYER_SELECTION_CODES.NO_OFFER };
      decisions.set(id, {
        digest,
        expiresAt: result.winner.quote.offer.expiresAt,
        authorized: false,
        identity: {
          owner: result.winner.candidate.owner,
          nodeId: result.winner.candidate.nodeId,
        },
      });
      return { ok: true };
    },
  };
}

async function authorizeIdentity(
  prior: Decision,
  signal: AbortSignal,
  now: () => number,
  verifyIdentity?: (
    identity: Decision['identity'],
    signal: AbortSignal,
  ) => Promise<boolean>,
) {
  prior.authorized = true;
  try {
    return (
      (!verifyIdentity || (await verifyIdentity(prior.identity, signal))) &&
      !signal.aborted &&
      prior.expiresAt > now()
    );
  } catch {
    return false;
  }
}
