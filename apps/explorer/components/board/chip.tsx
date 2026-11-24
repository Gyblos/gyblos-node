import type { ReactNode } from 'react';

import { Chip as BoardChip } from '../../boardui/components/base/badges/chip';

export function Chip({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'brand';
  children: ReactNode;
}) {
  return (
    <BoardChip
      variant="caption"
      color={tone === 'brand' ? 'blue' : 'neutral'}
      className="gap-1.5 py-0.5 font-mono"
    >
      {children}
    </BoardChip>
  );
}
