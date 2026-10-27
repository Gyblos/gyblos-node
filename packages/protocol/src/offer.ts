// Owns the wire shape of the signed private inference offer ({ offer, signature }).
// Types only: trust policy lives in core, wallet signing in node; no SDK dependencies.
import type { EngineCapabilities, EngineDescription } from './engine';

export interface InferenceOffer {
  schemaVersion: number;
  protocol: string;
  owner: string;
  nodeId: string;
  endpoint: { relayUrl: string | null; directAddresses: string[] };
  relayOnly: boolean;
  network: string;
  mint: string;
  payTo: string;
  feePayer: string;
  authorizer: string;
  buyer: string;
  issuedAt: number;
  expiresAt: number;
  prices: { inputAtomic: string; outputAtomic: string };
  maxAtomic: string;
  maxTokens: number;
  model: EngineDescription;
  capabilities: EngineCapabilities;
  meteringMode: 'recounted' | 'declared';
}

export interface SignedInferenceOffer {
  offer: InferenceOffer;
  signature: string;
}
