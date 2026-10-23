// Parses bounded control response shapes; caller policy authenticates catalogs and matches request terms.
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_METHODS,
  CONTROL_VERSION,
  PUBLIC_RECORD_KINDS,
} from './constants.js';
import type { ControlResponse, SignedPublicV2 } from './control-types.js';
import {
  controlFail,
  controlHex,
  controlObject,
  controlText,
} from './control-validation.js';
import { parseOfferV2 } from './offer-v2.js';
import { parsePublicV2 } from './public-v2.js';

export function parseControlResponse(value: unknown): ControlResponse {
  const failed =
    value && typeof value === 'object' && Object.hasOwn(value, 'error');
  const input = controlObject(value, [
    'version',
    'requestId',
    failed ? 'error' : 'result',
  ]);
  if (input.version !== CONTROL_VERSION)
    return controlFail(CONTROL_CODES.VERSION);
  const requestId = controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes);
  if (failed) {
    const error = controlObject(input.error, ['code']);
    for (const code of Object.values(CONTROL_CODES))
      if (error.code === code)
        return { version: CONTROL_VERSION, requestId, error: { code } };
    return controlFail();
  }
  const method: unknown =
    input.result && typeof input.result === 'object'
      ? Object.getOwnPropertyDescriptor(input.result, 'method')?.value
      : undefined;
  if (method === CONTROL_METHODS.CATALOG) {
    const result = controlObject(input.result, ['method', 'catalog']);
    const envelope = controlObject(result.catalog, ['record', 'signature']);
    const record = parsePublicV2(envelope.record);
    if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG) return controlFail();
    const catalog: SignedPublicV2 = {
      record,
      signature: controlHex(envelope.signature, CONTROL_LIMITS.signatureBytes),
    };
    return { version: CONTROL_VERSION, requestId, result: { method, catalog } };
  }
  if (method !== CONTROL_METHODS.OFFER) return controlFail();
  const result = controlObject(input.result, ['method', 'offer']);
  const envelope = controlObject(result.offer, ['offer', 'signature']);
  return {
    version: CONTROL_VERSION,
    requestId,
    result: {
      method,
      offer: {
        offer: parseOfferV2(envelope.offer),
        signature: controlText(
          envelope.signature,
          CONTROL_LIMITS.responseBytes,
        ),
      },
    },
  };
}
