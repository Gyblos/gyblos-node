// Estimates owner funding before simulation from the pinned registration layouts and Core create fee.
// This is an estimate, not a guarantee about upgradeable deployed programs; simulation still gates signing.
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

import { FINALIZED_COMMITMENT } from '@gyblos/config';

import { IDENTITY_ERROR_CODES, OWNER_REGISTRATION_COST } from './constants';
import { IdentityError } from './errors';
import { messageFee, type SponsoredMessage } from './registration';

export class OwnerRegistrationFundsError extends IdentityError {
  constructor(
    readonly estimatedTotalLamports: bigint,
    readonly missingLamports: bigint,
  ) {
    super(
      IDENTITY_ERROR_CODES.INSUFFICIENT_FUNDS,
      'Owner needs additional SOL for registration.',
    );
  }
}
export async function estimateOwnerFunding(
  rpc: Rpc<SolanaRpcApi>,
  message: SponsoredMessage,
  owner: Address,
  agentUri: string,
  signal: AbortSignal,
  onEstimate?: (lamports: bigint) => void,
) {
  const sizes = [
    OWNER_REGISTRATION_COST.agentBytes,
    OWNER_REGISTRATION_COST.metadataBytes,
    OWNER_REGISTRATION_COST.coreBaseBytes +
      new TextEncoder().encode(agentUri).length,
  ];
  const rents = await Promise.all(
    sizes.map((size) =>
      rpc
        .getMinimumBalanceForRentExemption(BigInt(size), {
          commitment: FINALIZED_COMMITMENT,
        })
        .send({ abortSignal: signal }),
    ),
  );
  const feeLamports = await messageFee(rpc, message, signal);
  const estimatedTotalLamports =
    rents.reduce<bigint>(
      (sum, rent) => sum + rent,
      OWNER_REGISTRATION_COST.coreCreateLamports,
    ) + feeLamports;
  signal.throwIfAborted();
  if (rents.some((rent) => typeof rent !== 'bigint' || rent < 0n))
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      'Invalid rent estimate.',
    );
  onEstimate?.(estimatedTotalLamports);
  const balance = await rpc
    .getBalance(owner, { commitment: FINALIZED_COMMITMENT })
    .send({ abortSignal: signal });
  if (balance.value < estimatedTotalLamports)
    throw new OwnerRegistrationFundsError(
      estimatedTotalLamports,
      estimatedTotalLamports - balance.value,
    );
  return { estimatedTotalLamports, feeLamports };
}
