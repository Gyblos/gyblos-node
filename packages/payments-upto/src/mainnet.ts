// Prepares candidate USDC buyer terms and keeps mainnet payments disabled. A syntactically valid
// treasury is not proof that the address is the founder-approved multisig.
import { isAddress } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS } from '@x402/svm';

import { PROTOCOL_FEE } from '@gyblos/config';
import { isMainnetPilotDepositAllowed } from '@gyblos/core/mainnet-pilot';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import type { UptoBuyerPolicy } from './client';

export function assertMainnetPilotDeposit(terms: {
  network: string;
  mint: string;
  maxAtomic: string;
}): void {
  if (terms.network !== SOLANA_MAINNET_CAIP2) return;
  if (
    terms.mint !== USDC_MAINNET_ADDRESS ||
    !isMainnetPilotDepositAllowed(terms.maxAtomic)
  )
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
}

export function mainnetPilotBuyerPolicy(input: {
  treasury: string;
  maxAtomic: string;
}): UptoBuyerPolicy {
  if (
    !isAddress(input.treasury) ||
    !isMainnetPilotDepositAllowed(input.maxAtomic)
  )
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  return {
    network: SOLANA_MAINNET_CAIP2,
    mint: USDC_MAINNET_ADDRESS,
    protocolFeeBps: PROTOCOL_FEE.bps,
    treasury: input.treasury,
    maxAtomic: input.maxAtomic,
  };
}

// This is a code-level lock, not an environment flag. Enabling mainnet requires a reviewed change.
export function assertPaymentNetworkEnabled(network: string): void {
  if (network === SOLANA_MAINNET_CAIP2)
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
}
