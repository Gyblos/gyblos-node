// Exact USDC conversion and gyblos.toml price bounds; pure, with no input values in errors.
// Buyer ceilings retain the protocol u64 range; seller TOML prices keep their existing narrower bound.
import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';

import {
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_LIMITS,
  NODE_ERROR_CODES,
  USDC_ATOMIC_UNITS_PER_USDC,
} from './constants';
import { NodeError } from './errors';

// No sign, exponent, leading zeros or empty part; trailing fractional zeros are dropped afterwards.
const PRICE_DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const TRAILING_ZEROS = /0+$/;
const ZERO_DIGIT = '0';

export type PriceDecimal =
  | { ok: true; integer: string; fraction: string; canonical: string }
  | {
      ok: false;
      code:
        | typeof NODE_CONFIG_ISSUE_CODES.NON_CANONICAL_DECIMAL
        | typeof NODE_CONFIG_ISSUE_CODES.PRICE_OUT_OF_RANGE;
    };

// "0.10", "1.50" and "2.0" normalize to "0.1", "1.5" and "2"; precision is checked after normalizing.
function readDecimal(value: string, integerDigits: number): PriceDecimal {
  const match = PRICE_DECIMAL.exec(value);
  if (!match)
    return { ok: false, code: NODE_CONFIG_ISSUE_CODES.NON_CANONICAL_DECIMAL };
  const [, integer = '', written = ''] = match;
  const fraction = written.replace(TRAILING_ZEROS, '');
  if (
    integer.length > integerDigits ||
    fraction.length > NODE_CONFIG_LIMITS.priceFractionDigits
  )
    return { ok: false, code: NODE_CONFIG_ISSUE_CODES.PRICE_OUT_OF_RANGE };
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  return { ok: true, integer, fraction, canonical };
}

export function readPriceDecimal(value: string): PriceDecimal {
  return readDecimal(value, NODE_CONFIG_LIMITS.priceIntegerDigits);
}

function atomicUnits(price: Extract<PriceDecimal, { ok: true }>): bigint {
  const fraction = price.fraction.padEnd(
    NODE_CONFIG_LIMITS.priceFractionDigits,
    ZERO_DIGIT,
  );
  return BigInt(price.integer) * USDC_ATOMIC_UNITS_PER_USDC + BigInt(fraction);
}

// General USDC ceilings fit the existing protocol u64 range, independently of seller TOML price caps.
export function usdcToAtomic(decimal: string): bigint {
  const parsed = readDecimal(decimal, PUBLIC_RECORD_LIMITS.maxAtomicDigits);
  if (!parsed.ok) throw new NodeError(NODE_ERROR_CODES.INVALID_PRICE);
  const amount = atomicUnits(parsed);
  if (amount > BigInt(PUBLIC_RECORD_LIMITS.maxAtomic))
    throw new NodeError(NODE_ERROR_CODES.INVALID_PRICE);
  return amount;
}

// USDC per million tokens to atomic units (10^-6 USDC) per million tokens, the protocol v2 price unit.
export function pricePerMtokToAtomicPerMtok(decimal: string): bigint {
  const price = readPriceDecimal(decimal);
  if (!price.ok) throw new NodeError(NODE_ERROR_CODES.INVALID_PRICE);
  return atomicUnits(price);
}
