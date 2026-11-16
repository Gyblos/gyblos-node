// Owns the receipt upload envelope version, signing domain and closed catalogs; no receipt domain.
export const RECEIPT_UPLOAD = {
  version: 1,
  domain: 'gyblos/receipt-upload/v1\n',
  // Receipts per envelope; the uploader batches beyond this.
  maxItems: 50,
  nonceBytes: 16,
  maxAppVersionCharacters: 32,
  // Canonical bytes of the whole signed envelope (items carry receipts of a few KiB each).
  maxBytes: 262_144,
} as const;

// Which application produced the upload; it must agree with the uploader's role.
export const RECEIPT_UPLOAD_CLIENTS = {
  SELLER_NODE: 'seller-node',
  BUYER_CLI: 'buyer-cli',
  BUYER_DESKTOP: 'buyer-desktop',
} as const;
export type ReceiptUploadClientKind =
  (typeof RECEIPT_UPLOAD_CLIENTS)[keyof typeof RECEIPT_UPLOAD_CLIENTS];

export const RECEIPT_UPLOAD_PLATFORMS = {
  MACOS: 'macos',
  WINDOWS: 'windows',
  LINUX: 'linux',
  OTHER: 'other',
} as const;
export type ReceiptUploadPlatform =
  (typeof RECEIPT_UPLOAD_PLATFORMS)[keyof typeof RECEIPT_UPLOAD_PLATFORMS];

export const RECEIPT_UPLOAD_ARCHES = {
  X64: 'x64',
  ARM64: 'arm64',
  OTHER: 'other',
} as const;
export type ReceiptUploadArch =
  (typeof RECEIPT_UPLOAD_ARCHES)[keyof typeof RECEIPT_UPLOAD_ARCHES];
