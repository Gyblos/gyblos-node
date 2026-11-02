// Pure pilot deposit policy for six-decimal USDC atomic units. This does not verify the asset or
// connect the policy to payment execution; callers must establish both separately.
import { MAINNET_PILOT_MAX_USDC_ATOMIC } from './constants';

export function isMainnetPilotDepositAllowed(atomic: unknown): boolean {
  if (
    typeof atomic !== 'string' ||
    atomic.length > MAINNET_PILOT_MAX_USDC_ATOMIC.length ||
    !/^[1-9][0-9]*$/.test(atomic)
  )
    return false;
  return BigInt(atomic) <= BigInt(MAINNET_PILOT_MAX_USDC_ATOMIC);
}
