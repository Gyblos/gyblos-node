// Pure atomic-unit permission policy; collateral and wallet transfers are separate authorities.
import { buyerAtomic } from '@gyblos/protocol/buyer-api';

export function permitsBuyerKeyReservation(
  limit: string,
  spent: string,
  reserved: string,
  maximum: string,
) {
  return (
    [limit, spent, reserved, maximum].every(buyerAtomic) &&
    BigInt(spent) + BigInt(reserved) + BigInt(maximum) <= BigInt(limit)
  );
}

export function buyerKeyCeiling(
  limit: string,
  spent: string,
  reserved: string,
  configured: string,
) {
  if (
    !permitsBuyerKeyReservation(limit, spent, reserved, '0') ||
    !buyerAtomic(configured)
  )
    return undefined;
  const remaining = BigInt(limit) - BigInt(spent) - BigInt(reserved);
  return String(
    remaining < BigInt(configured) ? remaining : BigInt(configured),
  );
}
