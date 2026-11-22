// Owns the identity claim version, signing domain, proof line prefix, closed kinds and formats. The GitHub
// kind names an account and a public gist whose text carries `proofPrefix` + the NodeId.
export const IDENTITY_CLAIM_KINDS = { GITHUB: 'github' } as const;
export type IdentityClaimKind =
  (typeof IDENTITY_CLAIM_KINDS)[keyof typeof IDENTITY_CLAIM_KINDS];
export const IDENTITY_CLAIM = {
  schemaVersion: 1,
  domain: 'gyblos/identity-claim/v1\n',
  proofPrefix: 'gyblos-node=',
  // A GitHub login, lowercase only: alphanumerics with single hyphens between them, and at most
  // `maxAccountCharacters` characters in all (checked separately; the pattern alone has no length cap).
  githubAccount: /^[a-z0-9](?:-?[a-z0-9])*$/,
  maxAccountCharacters: 39,
  // A gist id: lowercase hex, 20 to 32 characters.
  gistId: /^[0-9a-f]{20,32}$/,
  maxGistCharacters: 32,
} as const;
