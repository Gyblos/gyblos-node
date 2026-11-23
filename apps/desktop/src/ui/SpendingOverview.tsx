import { Gauge, Wallet } from '@phosphor-icons/react';

import { x402Amount, x402Asset } from '../x402-model';
import { Section } from './Management';
import { Button, StatCard, StatGrid } from './UI';
import type { X402View } from './useX402';

export function SpendingOverview({
  buyer,
  onLimits,
}: {
  buyer?: X402View;
  onLimits(): void;
}) {
  const state = buyer?.state;
  const policy = state?.summary.policy;
  const summary = state?.summary;
  const known =
    !!policy && !!summary?.available && !summary.blocked && !state?.error;
  const format = (atomic: string) =>
    policy ? x402Amount(atomic, policy) + ' ' + x402Asset(policy) : null;
  const remaining =
    known && summary.active
      ? BigInt(summary.limitAtomic) - BigInt(summary.spentAtomic)
      : null;
  return (
    <Section
      title="Spending"
      action={<Button onClick={onLimits}>Spending limits</Button>}
    >
      <StatGrid>
        <StatCard
          label="Chat spending"
          value={known ? format(summary.spentAtomic) : null}
          detail="Current USDC chat session"
        />
        <StatCard
          label="Chat spending limit"
          icon={Gauge}
          value={known && summary.active ? format(summary.limitAtomic) : null}
          detail="API keys have separate limits"
        />
        <StatCard
          label="Remaining"
          icon={Wallet}
          value={
            remaining !== null && remaining >= 0n
              ? format(String(remaining))
              : null
          }
        />
      </StatGrid>
    </Section>
  );
}
