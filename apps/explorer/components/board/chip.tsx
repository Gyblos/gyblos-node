import type { ReactNode } from 'react';

import { Chip as BoardChip } from '../../boardui/components/base/badges/chip';

export function Chip({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'online';
  children: ReactNode;
}) {
  return (
    <BoardChip
      variant="caption"
      color={tone === 'online' ? 'lime' : 'neutral'}
      className="font-mono"
    >
      {children}
    </BoardChip>
  );
}
