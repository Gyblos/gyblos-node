// Owns the payments-upto catalogs: which port call a failure happened in, and the fields of a
// seller's own payment description.
export const PAYMENT_PHASES = { ADMIT: 'admit', SETTLE: 'settle' } as const;
export type PaymentPhase = (typeof PAYMENT_PHASES)[keyof typeof PAYMENT_PHASES];

// Every PaymentDescription field; terms naming another value for any of them are not this seller's.
export const DESCRIPTION_FIELDS = [
  'network',
  'mint',
  'payTo',
  'feePayer',
  'authorizer',
  'protocolFeeBps',
  'treasury',
] as const;
