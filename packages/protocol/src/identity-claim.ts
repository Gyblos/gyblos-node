// Owns the signed identity claim v1: a node names an external account it controls (GitHub: an account
// and a public gist) or cancels its claim. The node key signs; checking the account side (the gist
// carrying githubProofLine) and freshness or replay belong to the verifier, such as the discovery index.
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  IDENTITY_CLAIM,
  IDENTITY_CLAIM_KINDS,
  type IdentityClaimKind,
} from './constants';
import {
  controlFail,
  controlHex,
  controlInteger,
  controlObject,
  controlVerify,
} from './control-validation';
import { bytesHex, hexBytes } from './public-validation';
import { sign, type Signer } from './signing';

export interface IdentityClaimV1 {
  schemaVersion: typeof IDENTITY_CLAIM.schemaVersion;
  kind: IdentityClaimKind;
  // The claiming node's Ed25519 public key, 64 lowercase hex characters; it signs the claim.
  nodeId: string;
  // Both null cancels the node's claim; otherwise both are set.
  account: string | null;
  gist: string | null;
  // Milliseconds since the Unix epoch; a verifier keeps only the newest claim per node.
  issuedAt: number;
}
export interface SignedIdentityClaim {
  claim: IdentityClaimV1;
  // Hex Ed25519 by claim.nodeId over IDENTITY_CLAIM.domain + canonical JSON of claim.
  signature: string;
}

const CLAIM_KEYS = [
  'schemaVersion',
  'kind',
  'nodeId',
  'account',
  'gist',
  'issuedAt',
] as const;

function nullableMatch(value: unknown, pattern: RegExp): string | null {
  if (value === null) return null;
  return typeof value === 'string' && pattern.test(value)
    ? value
    : controlFail();
}

// Strict and detaching: exact keys, lowercase account and gist id, both null or both set.
export function parseIdentityClaim(value: unknown): IdentityClaimV1 {
  const input = controlObject(value, CLAIM_KEYS);
  if (input.schemaVersion !== IDENTITY_CLAIM.schemaVersion)
    return controlFail(CONTROL_CODES.VERSION);
  if (input.kind !== IDENTITY_CLAIM_KINDS.GITHUB) return controlFail();
  const account = nullableMatch(input.account, IDENTITY_CLAIM.githubAccount);
  const gist = nullableMatch(input.gist, IDENTITY_CLAIM.gistId);
  if ((account === null) !== (gist === null)) return controlFail();
  return {
    schemaVersion: IDENTITY_CLAIM.schemaVersion,
    kind: IDENTITY_CLAIM_KINDS.GITHUB,
    nodeId: controlHex(input.nodeId),
    account,
    gist,
    issuedAt: controlInteger(input.issuedAt),
  };
}

// The line the gist must contain, on a line of its own.
export function githubProofLine(nodeId: string): string {
  return IDENTITY_CLAIM.proofPrefix + controlHex(nodeId);
}

export async function signIdentityClaim(
  value: IdentityClaimV1,
  signer: Signer,
): Promise<SignedIdentityClaim> {
  const claim = parseIdentityClaim(value);
  const signature = Uint8Array.from(
    await sign(IDENTITY_CLAIM.domain, claim, signer),
  );
  if (
    signature.length !== CONTROL_LIMITS.signatureBytes ||
    !(await controlVerify(
      IDENTITY_CLAIM.domain,
      claim,
      hexBytes(claim.nodeId),
      signature,
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { claim, signature: bytesHex(signature) };
}

// Parses `{ claim, signature }`, detaches it and checks the node's signature. Shape failures are
// INVALID or VERSION, a bad signature is SIGNATURE.
export async function verifyIdentityClaim(
  value: unknown,
): Promise<SignedIdentityClaim> {
  const input = controlObject(value, ['claim', 'signature']);
  const claim = parseIdentityClaim(input.claim);
  const signature = controlHex(input.signature, CONTROL_LIMITS.signatureBytes);
  if (
    !(await controlVerify(
      IDENTITY_CLAIM.domain,
      claim,
      hexBytes(claim.nodeId),
      hexBytes(signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { claim, signature };
}
