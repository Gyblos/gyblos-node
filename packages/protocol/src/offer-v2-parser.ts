// Validates detached private v2 offer structure; payment admission and request matching stay outside.
import {
  CONTROL_AVAILABILITY,
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_METERING_MODES,
  CONTROL_PAID_ALPN,
  CONTROL_RECORD_VERSION,
  MODEL_IDENTITIES,
  PUBLIC_RECORD_LIMITS,
} from './constants.js';
import { parseModelSelection } from './control-requests.js';
import type { InferenceOfferV2 } from './control-types.js';
import {
  controlAddress,
  controlArray,
  controlAtomic,
  controlFail,
  controlHex,
  controlInteger,
  controlNetwork,
  controlObject,
  controlReasoning,
  controlText,
} from './control-validation.js';

function endpointV2(value: unknown, relayOnly: unknown) {
  const input = controlObject(value, ['relayUrl', 'directAddresses']);
  if (typeof relayOnly !== 'boolean') return controlFail();
  const directAddresses = controlArray(
    input.directAddresses,
    CONTROL_LIMITS.maxDirectAddresses,
  ).map((item) => controlText(item));
  if (relayOnly && directAddresses.length)
    return controlFail(CONTROL_CODES.POLICY);
  let relayUrl: string | null = null;
  if (input.relayUrl !== null) {
    relayUrl = controlText(input.relayUrl);
    let url: URL;
    try {
      url = new URL(relayUrl);
    } catch {
      return controlFail();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return controlFail();
  }
  return { endpoint: { relayUrl, directAddresses }, relayOnly };
}
function modelV2(value: unknown, identity: string) {
  const hasDigest =
    !!value && typeof value === 'object' && Object.hasOwn(value, 'digest');
  const input = controlObject(value, [
    'name',
    'contextTokens',
    ...(hasDigest ? ['digest'] : []),
  ]);
  if (!hasDigest && identity === MODEL_IDENTITIES.DIGEST) return controlFail();
  return {
    name: controlText(input.name),
    ...(hasDigest ? { digest: controlText(input.digest) } : {}),
    contextTokens: controlInteger(
      input.contextTokens,
      1,
      PUBLIC_RECORD_LIMITS.maxContextTokens,
    ),
  };
}
function capabilitiesV2(value: unknown) {
  const input = controlObject(value, [
    'reportsUsage',
    'logprobs',
    'cancellable',
    'recountable',
    'modelIdentity',
  ]);
  if (
    typeof input.reportsUsage !== 'boolean' ||
    typeof input.logprobs !== 'boolean' ||
    typeof input.cancellable !== 'boolean' ||
    typeof input.recountable !== 'boolean' ||
    (input.modelIdentity !== MODEL_IDENTITIES.DIGEST &&
      input.modelIdentity !== MODEL_IDENTITIES.NAME_ONLY)
  )
    return controlFail();
  return {
    reportsUsage: input.reportsUsage,
    logprobs: input.logprobs,
    cancellable: input.cancellable,
    recountable: input.recountable,
    modelIdentity: input.modelIdentity,
  };
}
const OFFER_KEYS = [
  'schemaVersion',
  'protocol',
  'owner',
  'nodeId',
  'buyer',
  'buyerNodeId',
  'requestId',
  'requestDigest',
  'catalogDigest',
  'selection',
  'reasoning',
  'network',
  'mint',
  'payTo',
  'feePayer',
  'authorizer',
  'issuedAt',
  'expiresAt',
  'endpoint',
  'relayOnly',
  'prices',
  'maxAtomic',
  'maxTokens',
  'model',
  'capabilities',
  'meteringMode',
  'availability',
];
export function parseOfferV2(value: unknown): InferenceOfferV2 {
  const input = controlObject(value, OFFER_KEYS);
  if (
    input.schemaVersion !== CONTROL_RECORD_VERSION ||
    input.protocol !== CONTROL_PAID_ALPN
  )
    return controlFail(CONTROL_CODES.VERSION);
  const prices = controlObject(input.prices, ['inputAtomic', 'outputAtomic']);
  const availability = controlObject(input.availability, [
    'state',
    'observedAt',
  ]);
  if (
    availability.state !== CONTROL_AVAILABILITY ||
    (input.meteringMode !== CONTROL_METERING_MODES.RECOUNTED &&
      input.meteringMode !== CONTROL_METERING_MODES.DECLARED)
  )
    return controlFail();
  const capabilities = capabilitiesV2(input.capabilities);
  return {
    schemaVersion: CONTROL_RECORD_VERSION,
    protocol: CONTROL_PAID_ALPN,
    owner: controlAddress(input.owner),
    nodeId: controlHex(input.nodeId),
    buyer: controlAddress(input.buyer),
    buyerNodeId: controlHex(input.buyerNodeId),
    requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
    requestDigest: controlHex(input.requestDigest),
    catalogDigest: controlHex(input.catalogDigest),
    selection: parseModelSelection(input.selection),
    reasoning: controlReasoning(input.reasoning),
    network: controlNetwork(input.network),
    mint: controlAddress(input.mint),
    payTo: controlAddress(input.payTo),
    feePayer: controlAddress(input.feePayer),
    authorizer: controlAddress(input.authorizer),
    issuedAt: controlInteger(input.issuedAt),
    expiresAt: controlInteger(input.expiresAt),
    ...endpointV2(input.endpoint, input.relayOnly),
    prices: {
      inputAtomic: controlAtomic(prices.inputAtomic),
      outputAtomic: controlAtomic(prices.outputAtomic),
    },
    maxAtomic: controlAtomic(input.maxAtomic),
    maxTokens: controlInteger(
      input.maxTokens,
      1,
      PUBLIC_RECORD_LIMITS.maxContextTokens,
    ),
    model: modelV2(input.model, capabilities.modelIdentity),
    capabilities: {
      ...capabilities,
      modelIdentity:
        capabilities.modelIdentity === MODEL_IDENTITIES.DIGEST
          ? MODEL_IDENTITIES.DIGEST
          : MODEL_IDENTITIES.NAME_ONLY,
    },
    meteringMode: input.meteringMode,
    availability: {
      state: CONTROL_AVAILABILITY,
      observedAt: controlInteger(availability.observedAt),
    },
  };
}
