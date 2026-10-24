// Ensures advisory v2 selection cannot imply new execution semantics for the existing v1 offer.
// No conversion, authorization or payment execution occurs here.
import { REASONING_LEVELS } from '@gyblos/protocol/constants';
import type { InferenceOffer } from '@gyblos/protocol/offer';

import { BUYER_SELECTION_CODES } from './constants.js';
import type { SelectionDecision } from './selection.js';

export function requireLegacyQuoteCompatibility(
  result: SelectionDecision,
  trusted: InferenceOffer,
):
  | SelectionDecision
  | { ok: false; code: typeof BUYER_SELECTION_CODES.V1_INCOMPATIBLE } {
  if (!result.ok) return result;
  const quote = result.winner.quote.offer;
  // v1 has no public model selection or reasoning field. Only the unchanged engine description,
  // OFF reasoning, payment identities and economic terms can proceed through its existing flow.
  if (
    quote.reasoning !== REASONING_LEVELS.OFF ||
    quote.model.name !== trusted.model.name ||
    quote.model.digest !== trusted.model.digest ||
    quote.model.contextTokens !== trusted.model.contextTokens ||
    quote.network !== trusted.network ||
    quote.mint !== trusted.mint ||
    quote.payTo !== trusted.payTo ||
    quote.feePayer !== trusted.feePayer ||
    quote.authorizer !== trusted.authorizer ||
    quote.prices.inputAtomic !== trusted.prices.inputAtomic ||
    quote.prices.outputAtomic !== trusted.prices.outputAtomic ||
    quote.maxTokens > trusted.maxTokens ||
    quote.maxAtomic !== trusted.maxAtomic ||
    quote.meteringMode !== trusted.meteringMode ||
    Object.entries(quote.capabilities).some(
      ([key, value]) => Reflect.get(trusted.capabilities, key) !== value,
    )
  )
    return { ok: false, code: BUYER_SELECTION_CODES.V1_INCOMPATIBLE };
  return result;
}
