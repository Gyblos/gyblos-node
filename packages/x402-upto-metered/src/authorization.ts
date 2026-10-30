// The payer side: builds and signs the channel open with the x402 upto client, offline given the
// recent-block hints, and carries the SDK payload as opaque base64.
import type { TransactionSigner } from '@solana/kit';
import { UptoSvmScheme as UptoClientScheme } from '@x402/svm/upto/client';

import { UPTO, UPTO_ERROR_CODES } from './constants';
import { UptoError } from './errors';
import { uptoRequirements } from './requirements';
import type { UptoAuthorization, UptoClientHints, UptoTerms } from './types';

// The fields of the SDK's upto payload this package reads; the rest stays opaque.
export interface UptoPayloadFields {
  channelId: string;
  from: string;
  maxAmount: string;
}

export async function createUptoAuthorization(
  payer: TransactionSigner,
  terms: UptoTerms,
  hints: UptoClientHints,
): Promise<UptoAuthorization> {
  const created = await new UptoClientScheme(payer).createPaymentPayload(
    UPTO.x402Version,
    uptoRequirements(terms, hints),
  );
  const fields = created.payload as unknown as UptoPayloadFields;
  return {
    channelId: fields.channelId,
    payer: fields.from,
    maxAtomic: fields.maxAmount,
    payload: Buffer.from(JSON.stringify(created.payload)).toString('base64'),
  };
}

// The SDK payload inside an authorization, or an AUTHORIZATION_MISMATCH error.
export function decodeUptoPayload(
  authorization: UptoAuthorization,
): Record<string, unknown> & UptoPayloadFields {
  try {
    const raw = Buffer.from(authorization.payload, 'base64');
    if (raw.toString('base64') !== authorization.payload) throw new Error();
    const decoded: unknown = JSON.parse(raw.toString('utf8'));
    if (
      decoded &&
      typeof decoded === 'object' &&
      'channelId' in decoded &&
      'from' in decoded &&
      'maxAmount' in decoded &&
      typeof decoded.channelId === 'string' &&
      typeof decoded.from === 'string' &&
      typeof decoded.maxAmount === 'string'
    )
      return decoded as Record<string, unknown> & UptoPayloadFields;
  } catch {
    // Falls through to the static mismatch below.
  }
  throw new UptoError(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH);
}
