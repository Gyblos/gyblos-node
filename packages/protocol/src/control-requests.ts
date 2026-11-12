// Parses detached control requests and hashes all terms; transport supplies authenticated peer identity.
import {
  CONTROL_CODES,
  CONTROL_DOMAINS,
  CONTROL_LIMITS,
  CONTROL_METHODS,
  CONTROL_VERSION,
  PUBLIC_RECORD_LIMITS,
} from './constants';
import type { ControlQuery, ModelSelection, OfferQuery } from './control-types';
import {
  controlAddress,
  controlAtomic,
  controlFail,
  controlHex,
  controlIdentifier,
  controlInteger,
  controlNetwork,
  controlObject,
  controlReasoning,
} from './control-validation';
import { parseTokenPricesV2 } from './pricing-v2';
import { bytesHex } from './public-validation';
import { signingBytes } from './signing';

export function parseModelSelection(value: unknown): ModelSelection {
  const input = controlObject(value, ['modelId', 'variant', 'quantization']);
  return {
    modelId: controlIdentifier(input.modelId),
    variant: input.variant === null ? null : controlIdentifier(input.variant),
    quantization:
      input.quantization === null
        ? null
        : controlIdentifier(input.quantization),
  };
}
export function parseControlQuery(value: unknown): ControlQuery {
  const input = controlObject(value, [
    'version',
    'requestId',
    'method',
    'params',
  ]);
  if (input.version !== CONTROL_VERSION)
    return controlFail(CONTROL_CODES.VERSION);
  const requestId = controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes);
  if (
    input.method === CONTROL_METHODS.CATALOG ||
    input.method === CONTROL_METHODS.PRESENCE
  ) {
    controlObject(input.params, []);
    return {
      version: CONTROL_VERSION,
      requestId,
      method: input.method,
      params: {},
    };
  }
  if (input.method !== CONTROL_METHODS.OFFER) return controlFail();
  const tools =
    !!input.params &&
    typeof input.params === 'object' &&
    Object.hasOwn(input.params, 'tools');
  const params = controlObject(input.params, [
    ...(tools ? ['tools'] : []),
    'buyer',
    'buyerNodeId',
    'selection',
    'reasoning',
    'maxTokens',
    'maxAtomic',
    'priceCeilings',
    'network',
    'asset',
    'catalogDigest',
  ]);
  return {
    version: CONTROL_VERSION,
    requestId,
    method: CONTROL_METHODS.OFFER,
    params: {
      buyer: controlAddress(params.buyer),
      buyerNodeId: controlHex(params.buyerNodeId),
      selection: parseModelSelection(params.selection),
      reasoning: controlReasoning(params.reasoning),
      maxTokens: controlInteger(
        params.maxTokens,
        1,
        PUBLIC_RECORD_LIMITS.maxContextTokens,
      ),
      maxAtomic: controlAtomic(params.maxAtomic),
      priceCeilings: parseTokenPricesV2(params.priceCeilings),
      network: controlNetwork(params.network),
      asset: controlAddress(params.asset),
      catalogDigest: controlHex(params.catalogDigest),
      ...(tools ? { tools: params.tools === true ? true : controlFail() } : {}),
    },
  };
}
export function parseOfferQuery(
  value: unknown,
  remoteNodeId?: string,
): OfferQuery {
  const query = parseControlQuery(value);
  if (query.method !== CONTROL_METHODS.OFFER) return controlFail();
  if (
    remoteNodeId !== undefined &&
    query.params.buyerNodeId !== controlHex(remoteNodeId)
  )
    return controlFail(CONTROL_CODES.POLICY);
  return query;
}
export async function controlRequestDigest(value: unknown): Promise<string> {
  const query = parseControlQuery(value);
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        signingBytes(CONTROL_DOMAINS.REQUEST, query),
      ),
    ),
  );
}
