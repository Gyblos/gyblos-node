// Strict terms returned by the authenticated peer; agreement never grants new spending authority.
import { batchBoundary, batchFail } from './batch-channel-validation';
import { canonicalJson } from './canonical';
import { PAYMENT_BINDING } from './constants';
import {
  controlAddress,
  controlAtomic,
  controlHex,
  controlInteger,
  controlNetwork,
  controlObject,
} from './control-validation';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  type PaymentSessionTerms,
} from './payment-session';

export function batchTerms(value: unknown): PaymentSessionTerms {
  const row = controlObject(value, [
    'buyer',
    'buyerNodeId',
    'owner',
    'sellerNodeId',
    'network',
    'mint',
    'payTo',
    'feePayer',
    'authorizer',
    'treasury',
    'protocolFeeBps',
    'depositAtomic',
    'expiresAt',
    'withdrawDelaySeconds',
  ]);
  const terms = {
    buyer: controlAddress(row.buyer),
    buyerNodeId: controlHex(row.buyerNodeId, PAYMENT_SESSION.digestBytes),
    owner: controlAddress(row.owner),
    sellerNodeId: controlHex(row.sellerNodeId, PAYMENT_SESSION.digestBytes),
    network: controlNetwork(row.network),
    mint: controlAddress(row.mint),
    payTo: controlAddress(row.payTo),
    feePayer: controlAddress(row.feePayer),
    authorizer: controlAddress(row.authorizer),
    treasury: controlAddress(row.treasury),
    protocolFeeBps: controlInteger(
      row.protocolFeeBps,
      0,
      PAYMENT_BINDING.bpsDenominator,
    ),
    depositAtomic: controlAtomic(row.depositAtomic),
    expiresAt: controlInteger(row.expiresAt, 1),
    withdrawDelaySeconds: controlInteger(row.withdrawDelaySeconds, 1),
  };
  if (terms.depositAtomic === '0') return batchFail();
  return terms;
}
export function matchBatchTerms(
  value: unknown,
  authorized: unknown,
): PaymentSessionTerms {
  return batchBoundary(() => {
    const terms = batchTerms(value);
    if (canonicalJson(terms) !== canonicalJson(batchTerms(authorized)))
      return batchFail(SESSION_CODES.BINDING);
    return terms;
  });
}
