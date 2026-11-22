export const PROFILE_CLAIM = {
  schemaVersion: 1,
  domain: 'gyblos/profile-claim/v1\n',
  minNameCharacters: 1,
  maxNameCharacters: 32,
  maxInputCharacters: 256,
  normalization: 'NFKC',
  reservedWord: 'gyblos',
  forbidden:
    /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u,
  spaces: /\p{Zs}+/gu,
  allowed: /^[\p{L}\p{N} _.'-]+$/u,
  letterOrNumber: /[\p{L}\p{N}]/u,
} as const;

export const SELLER_NAME_ISSUES = {
  LENGTH: 'length',
  CHARACTERS: 'characters',
  RESERVED: 'reserved',
} as const;
export type SellerNameIssue =
  (typeof SELLER_NAME_ISSUES)[keyof typeof SELLER_NAME_ISSUES];
