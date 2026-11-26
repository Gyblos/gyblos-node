import { DeltaPill } from '../../boardui/components/application/dashboard/stat-cards';
import type { Delta } from './delta';

const COLORS = { good: 'lime', bad: 'rose', neutral: 'neutral' } as const;

export function DeltaChip({ delta, side }: { delta: Delta; side?: string }) {
  return (
    <DeltaPill
      delta={side ? `${side} ${delta.label}` : delta.label}
      deltaColor={COLORS[delta.tone]}
      direction={delta.direction}
    />
  );
}
