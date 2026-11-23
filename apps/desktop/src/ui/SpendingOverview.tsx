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
      className="preview-spending"
      action={
        <Button onClick={onLimits}>
          <Gauge size={16} />
          Spending limits
        </Button>
      }
    >
      <StatGrid>
        <StatCard
          label="Chat spending"
          help="USDC spent by the current chat session."
          value={known ? format(summary.spentAtomic) : null}
          detail="Current USDC chat session"
        />
        <StatCard
          label="Chat spending limit"
          help="Maximum spending authorized for this chat session."
          icon={Gauge}
          value={known && summary.active ? format(summary.limitAtomic) : null}
          detail="API keys have separate limits"
        />
        <StatCard
          label="Remaining"
          help="The portion of the chat spending limit still available."
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
