// The payer side: builds and signs the channel open with the x402 upto client, offline given the
// recent-block hints, and carries the SDK payload as opaque base64.
import type { TransactionSigner } from '@solana/kit';
import { UptoSvmScheme as UptoClientScheme } from '@x402/svm/upto/client';

import { UPTO, UPTO_ERROR_CODES } from './constants';
import { UptoError } from './errors';
import { uptoRequirements } from './requirements';
import type {
  UptoAuthorization,
  UptoClientHints,
  UptoPayloadFields,
  UptoTerms,
} from './types';

function isPayload(
  value: unknown,
): value is Record<string, unknown> & UptoPayloadFields {
  return (
    !!value &&
    typeof value === 'object' &&
    'channelId' in value &&
    'from' in value &&
    'maxAmount' in value &&
    'openSlot' in value &&
    typeof value.channelId === 'string' &&
    typeof value.from === 'string' &&
    typeof value.maxAmount === 'string' &&
    typeof value.openSlot === 'string' &&
    /^[0-9]+$/.test(value.openSlot)
  );
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
  if (!isPayload(created.payload))
    throw new UptoError(UPTO_ERROR_CODES.INTERNAL);
  return {
    channelId: created.payload.channelId,
    payer: created.payload.from,
    maxAtomic: created.payload.maxAmount,
    payload: Buffer.from(JSON.stringify(created.payload)).toString('base64'),
  };
}

// The SDK payload inside an authorization, or an AUTHORIZATION_MISMATCH error. Oversized,
// non-canonical base64 or malformed payloads never reach the SDK.
export function decodeUptoPayload(
  authorization: Pick<UptoAuthorization, 'payload'>,
): Record<string, unknown> & UptoPayloadFields {
  try {
    if (authorization.payload.length <= UPTO.payloadBytes) {
      const raw = Buffer.from(authorization.payload, 'base64');
      const decoded: unknown =
        raw.toString('base64') === authorization.payload
          ? JSON.parse(raw.toString('utf8'))
          : undefined;
      if (isPayload(decoded)) return decoded;
    }
  } catch {
    // Falls through to the static mismatch below.
  }
  throw new UptoError(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH);
}
