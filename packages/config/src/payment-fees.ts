// Seller-sponsored channel transaction ceilings, shared by admission and every SDK signing path.
// These do not authorize spending or cap rent, wallet balance, cumulative daily spend or network base fees.
export const PAYMENT_TRANSACTION_LIMITS = {
  maxComputeUnits: 400_000,
  maxPriorityFeeMicroLamports: 5_000,
  maxRequiredSignatures: 2,
} as const;
