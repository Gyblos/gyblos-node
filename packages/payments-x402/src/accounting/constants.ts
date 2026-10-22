// Owns the unchanged financial-proof guard messages and their derived type.
// No RPC, storage, inference or lab orchestration belongs here.
export const RENT_GUARDS = {
  ACCOUNT: 'Required transaction account missing.',
  SAFE_LAMPORTS: 'Unsafe lamport balance.',
  FRESH: 'A fresh escrow account is required.',
  FUNDED: 'Escrow account rent is required.',
  NONDECREASING: 'Escrow rent decreased between transactions.',
  CLOSED: 'The escrow account must be closed.',
  CREATION_COUNT: 'One canonical escrow creation is required.',
  CREATION_PROGRAM: 'Escrow creation must use the system program.',
  CREATION_PAYER: 'Escrow creation must be funded by the sponsor.',
  CREATION_OWNER: 'Escrow creation must assign the token program owner.',
  CREATION_SIZE: 'Escrow creation must use the canonical token account size.',
  CREATION_SAFE_AMOUNT: 'Escrow creation rent must be a positive safe integer.',
  CREATION_AMOUNT: 'Escrow creation rent must equal its funded balance.',
  CLOSURE_COUNT: 'One canonical escrow closure is required.',
  CLOSURE_PROGRAM: 'Escrow closure must use the token program.',
  CLOSURE_AUTHORITY: 'Escrow closure must be authorized by the channel.',
  CLOSURE_DESTINATION: 'Escrow closure rent must return to the sponsor.',
} as const;
export const TOKEN_GUARDS = {
  UNIQUE_ACCOUNT: 'Duplicate token account key.',
  BALANCE_ARRAY: 'Token balances must be an array.',
  UNIQUE_BALANCE: 'Duplicate token balance.',
  BALANCE_OWNER: 'Token balance owner must match the expected role.',
  BALANCE_MINT: 'Token balance mint must match the expected asset.',
  BALANCE_AMOUNT: 'Token balance must be an unsigned integer string.',
  TRANSFER_MINT: 'Token transfer mint must match the expected asset.',
  TRANSFER_AMOUNT: 'Token transfer must be an unsigned integer string.',
  CEILING_FORMAT: 'Token ceiling must be an unsigned integer string.',
  CEILING_POSITIVE: 'Token ceiling must be positive.',
  DISTINCT_ACCOUNTS:
    'Buyer, seller, escrow and treasury token accounts must be distinct.',
  DEPOSIT_SOURCE: 'Deposit tokens must come from the buyer ATA.',
  DEPOSIT_DESTINATION: 'Deposit tokens must go to the escrow ATA.',
  DEPOSIT_TOTAL: 'Deposit transfers must equal the original ceiling.',
  CLAIM_SOURCE: 'Claim tokens must come from the escrow ATA.',
  CLAIM_DESTINATION: 'Claim tokens must go to a canonical recipient ATA.',
  PRINCIPAL_TOTAL:
    'Charged plus refunded tokens must equal the original ceiling.',
  ESCROW_FRESH: 'Escrow must be empty before the deposit.',
  ESCROW_FUNDED: 'Escrow funding must equal the original ceiling.',
  PRINCIPAL: 'Escrow principal decreased.',
  ESCROW_EMPTY: 'Escrow must be empty after the claim.',
  SURPLUS: 'Treasury sweep must equal token surplus.',
  BUYER_DEPOSIT: 'Buyer deposit delta must equal the original ceiling.',
  SELLER_DEPOSIT: 'Seller balance must not change during deposit.',
  TREASURY_DEPOSIT: 'Treasury balance must not change during deposit.',
  BUYER_REFUND: 'Buyer claim delta must equal the refund.',
  SELLER_CHARGE: 'Seller claim delta must equal the charge.',
  TREASURY_DELTA: 'Treasury claim delta must equal the surplus sweep.',
} as const;
export const PROOF_GUARDS = {
  SIGNATURE_REQUIRED: 'A transaction signature is required.',
  TRANSACTION_AVAILABLE: 'Finalized transaction unavailable.',
  TRANSACTION_SUCCESS: 'Finalized transaction must have no error.',
  TRANSACTION_SLOT:
    'Finalized transaction slot must be a safe nonnegative integer.',
  TRANSACTION_SIGNATURE:
    'Finalized transaction signature must match the selected signature.',
  TRANSACTION_SPONSOR: 'Finalized transaction must use the expected sponsor.',
  TRANSACTION_FEE:
    'Finalized transaction fee must be a safe nonnegative integer.',
  CEILING_FORMAT: 'Proof ceiling must be an unsigned integer string.',
  CEILING_POSITIVE: 'Proof ceiling must be positive.',
  SIGNATURES_DISTINCT: 'Deposit and claim signatures must be distinct.',
  STATUS_COUNT: 'Every selected signature must have a status.',
  STATUS_AVAILABLE: 'Finalized signature unavailable.',
  STATUS_SUCCESS: 'Selected signature must have no error.',
  STATUS_FINALIZED: 'Selected signature must be finalized.',
  ORDER: 'Claim precedes deposit.',
  BUYER_SOL: 'Buyer SOL must not change in either selected transaction.',
  CHANNEL_FRESH: 'Channel must be unfunded before deposit.',
  CHANNEL_INTERVAL: 'Channel rent decreased between transactions.',
  CHANNEL_RETAINED: 'Retained channel lamports decreased during the claim.',
  DEPOSIT_SPONSOR:
    'Deposit sponsor delta must equal its fee plus channel and escrow rent.',
  CLAIM_SPONSOR:
    'Claim sponsor delta must equal its fee plus channel and escrow rent changes.',
  CHANNEL_CURRENT: 'Retained channel lamports decreased after the claim.',
  INITIAL_RENT: 'Initial channel rent is below minimum.',
} as const;

export type FinancialGuardMessage =
  | (typeof RENT_GUARDS)[keyof typeof RENT_GUARDS]
  | (typeof TOKEN_GUARDS)[keyof typeof TOKEN_GUARDS]
  | (typeof PROOF_GUARDS)[keyof typeof PROOF_GUARDS];
