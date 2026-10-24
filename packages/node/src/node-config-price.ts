// Price decimals for gyblos.toml: USDC per million tokens, normalized to one canonical spelling and
// converted exactly to atomic units. Pure; no protocol wiring and no input value in any error.
import {
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_LIMITS,
  NODE_ERROR_CODES,
  USDC_ATOMIC_UNITS_PER_USDC,
} from './constants.js';
import { NodeError } from './errors.js';

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
export function readPriceDecimal(value: string): PriceDecimal {
  const match = PRICE_DECIMAL.exec(value);
  if (!match)
    return { ok: false, code: NODE_CONFIG_ISSUE_CODES.NON_CANONICAL_DECIMAL };
  const [, integer = '', written = ''] = match;
  const fraction = written.replace(TRAILING_ZEROS, '');
  if (
    integer.length > NODE_CONFIG_LIMITS.priceIntegerDigits ||
    fraction.length > NODE_CONFIG_LIMITS.priceFractionDigits
  )
    return { ok: false, code: NODE_CONFIG_ISSUE_CODES.PRICE_OUT_OF_RANGE };
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  return { ok: true, integer, fraction, canonical };
}

// USDC per million tokens to atomic units (10^-6 USDC) per million tokens, the protocol v2 price unit.
export function pricePerMtokToAtomicPerMtok(decimal: string): bigint {
  const price = readPriceDecimal(decimal);
  if (!price.ok) throw new NodeError(NODE_ERROR_CODES.INVALID_PRICE);
  const fraction = price.fraction.padEnd(
    NODE_CONFIG_LIMITS.priceFractionDigits,
    ZERO_DIGIT,
  );
  return BigInt(price.integer) * USDC_ATOMIC_UNITS_PER_USDC + BigInt(fraction);
}
