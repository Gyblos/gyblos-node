// Formats model prices (USD per million tokens) for every place the app shows one. A non-zero price
// that two decimals would show as $0.00 keeps up to six decimals, so a paid model never looks free.
import { DESKTOP_X402 } from '../x402/constants';
import type { ModelOption } from './model-types';

const CENTS = 2;
// The smallest price two decimals show without rounding to $0.00.
const SMALLEST = 0.01;

export function usdPerMtok(value: number) {
  if (value > 0 && value < SMALLEST)
    return '$' + value.toFixed(DESKTOP_X402.ATOMIC_DECIMALS).replace(/0+$/, '');
  return '$' + value.toFixed(CENTS);
}

// "$in / $out", as rows and badges show a paid model's price.
export const priceRange = (model: Pick<ModelOption, 'input' | 'output'>) =>
  `${usdPerMtok(model.input)} / ${usdPerMtok(model.output)}`;
