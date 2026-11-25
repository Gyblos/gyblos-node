'use client';

import { useLocale } from 'react-aria-components';

export type Direction = 'ltr' | 'rtl';
export function useDirection(): Direction {
  return useLocale().direction;
}
