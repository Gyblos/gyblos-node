// Authenticates each fresh priced quote against independently pinned session terms and Iroh peer.
import { batchError, batchFail } from './batch-channel-validation';
import { verifyOfferV2 } from './offer-v2';
import { PAID_EXECUTION_CODES } from './paid/constants';
import { SESSION_CODES, type PaymentSessionTerms } from './payment-session';

export async function verifyBatchQuote(
  value: unknown,
  terms: Readonly<PaymentSessionTerms>,
  peer: string,
  now: number,
) {
  if (peer !== terms.buyerNodeId) return batchFail(PAID_EXECUTION_CODES.PEER);
  try {
    const offer = await verifyOfferV2(value, {
      owner: terms.owner,
      nodeId: terms.sellerNodeId,
      now,
    });
    if (
      offer.buyerNodeId !== peer ||
      offer.buyer !== terms.buyer ||
      offer.network !== terms.network ||
      offer.mint !== terms.mint ||
      offer.payTo !== terms.payTo ||
      offer.feePayer !== terms.feePayer ||
      offer.authorizer !== terms.authorizer
    )
      return batchFail(SESSION_CODES.BINDING);
    if (
      offer.maxAtomic === '0' ||
      (offer.prices.inputAtomicPerMtok === '0' &&
        offer.prices.outputAtomicPerMtok === '0')
    )
      return batchFail(PAID_EXECUTION_CODES.NOT_PAID);
    if (
      now >= terms.expiresAt ||
      BigInt(offer.maxAtomic) > BigInt(terms.depositAtomic)
    )
      return batchFail(SESSION_CODES.LIMIT);
    return offer;
  } catch (error) {
    throw batchError(error);
  }
}
