import { ArrowUpRight } from '@phosphor-icons/react';
import { useState } from 'react';

import { DEVNET_USDC } from '@gyblos/config/network';
import { atomicToUsdc } from '@gyblos/node/node-config-price';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import type { BuyerApiKeysSnapshot } from '@gyblos/protocol/buyer-api-keys';

import { RESPONSE_METRICS } from '../constants';
import { x402BudgetInput } from '../x402-model';
import { AmountField } from './AmountField';
import { Modal } from './Modal';
import { TONE, type Tone } from './status-tone';
import { Button, IconButton } from './UI';
import { useUsdcApiKeys } from './useUsdcApiKeys';
import type { X402View } from './useX402';
import { X402Payments } from './X402Payments';

const money = (atomic: bigint | null) =>
  atomic === null ? 'Unavailable' : atomicToUsdc(atomic) + ' USDC';
type Segment = { id: string; label: string; amount: bigint; tone: Tone };

function SpendingBar({
  segments,
  total,
}: {
  segments: Segment[];
  total: bigint;
}) {
  return (
    <div className="pk-segmented">
      <div className="pk-segmented-track" aria-hidden="true">
        {segments.map((segment) => (
          <span
            key={segment.id}
            data-tone={segment.tone}
            style={{
              width:
                (total
                  ? (Number(segment.amount) / Number(total)) *
                    RESPONSE_METRICS.PERCENT_SCALE
                  : 0) + '%',
            }}
          />
        ))}
      </div>
      <ul className="pk-legend" aria-label="Spending by source">
        {segments.map((segment) => (
          <li key={segment.id}>
            <span
              className="pk-dot"
              data-tone={segment.tone}
              aria-hidden="true"
            />
            {segment.label}
            <strong>{money(segment.amount)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
function KeyLimits({
  snapshot,
  manage,
}: {
  snapshot: BuyerApiKeysSnapshot | null;
  manage(): void;
}) {
  const active = snapshot?.keys.filter((entry) => !entry.revoked) ?? [];
  return (
    <section className="ui-section" aria-label="API key limits">
      <div className="ui-section-title">
        <h2>API keys</h2>
        <Button onClick={manage}>Manage keys</Button>
      </div>
      <p className="ui-help-text">
        Each API key has its own lifetime spending limit.
      </p>
      <div className="preview-simple-table-region">
        <table className="preview-simple-table">
          <caption className="sr-only">API key limits</caption>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col" className="preview-num">
                Used / limit
              </th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {active.map((entry) => (
              <tr key={entry.id}>
                <th scope="row">{entry.name}</th>
                <td className="preview-num preview-tabular">
                  {money(BigInt(entry.spentAtomic))} /{' '}
                  {money(BigInt(entry.limitAtomic))}
                </td>
                <td className="preview-num preview-limit-action">
                  <IconButton
                    label={'Manage ' + entry.name + ' in Connections'}
                    onClick={manage}
                  >
                    <ArrowUpRight size={14} />
                  </IconButton>
                </td>
              </tr>
            ))}
            {!active.length && (
              <tr>
                <td colSpan={3}>
                  {snapshot ? 'No active API keys.' : 'Key limits unavailable.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
type LimitControlProps = {
  buyer: X402View;
  policy: BuyerApiPolicy | null;
  open(amount: string): void;
};
function LimitControl({ buyer, policy, open }: LimitControlProps) {
  const [amount, setAmount] = useState('');
  const available =
    !!policy &&
    !buyer.busy &&
    buyer.state.summary.available &&
    !buyer.state.error &&
    !buyer.state.summary.blocked &&
    !buyer.state.summary.active &&
    policy.mint === DEVNET_USDC;
  const parse = (value: string) => parseLimit(policy, value);
  const valid = amount !== '' && parse(amount) !== null;
  return (
    <section className="ui-section" aria-label="Spending limit">
      <div className="preview-settings-rows">
        <div className="preview-setting-row">
          <div className="preview-setting-copy">
            <label htmlFor="chat-limit-amount">Spending limit</label>
            <small id="chat-limit-help" className="ui-help-text">
              Applies to this chat session. API keys have separate limits.
            </small>
          </div>
          <div className="preview-setting-control">
            {!available && (
              <Button disabled={buyer.busy} onClick={() => open('')}>
                Manage chat budget
              </Button>
            )}
            <AmountField
              compact
              disabled={!available}
              id="chat-limit-amount"
              value={
                available
                  ? amount
                  : buyer.state.summary.active &&
                      !buyer.state.error &&
                      !buyer.state.summary.blocked &&
                      buyer.state.summary.policy?.policyId ===
                        policy?.policyId &&
                      policy?.mint === DEVNET_USDC
                    ? atomicToUsdc(BigInt(buyer.state.summary.limitAtomic))
                    : ''
              }
              onChange={setAmount}
              unit="USDC"
              placeholder="0"
              parse={parse}
              format={atomicToUsdc}
              step={
                policy?.mint === DEVNET_USDC
                  ? BigInt(x402BudgetInput('0.5', policy))
                  : 1n
              }
              invalid={!!amount && !valid}
              describedBy="chat-limit-help"
              onEnter={() => {
                if (valid) open(amount);
              }}
              onEscape={() => setAmount('')}
            />
            {available && amount && (
              <Button
                disabled={buyer.busy || !valid}
                onClick={() => open(amount)}
              >
                Review limit
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
export function SpendingLimits({
  buyer,
  manage,
  onChat,
}: {
  buyer: X402View;
  manage(): void;
  onChat(): void;
}) {
  const { state } = useUsdcApiKeys();
  const [review, setReview] = useState<{
    policyId?: string;
    amount: string;
  } | null>(null);
  const { chat, policy, summary, sameChat, total, segments, keySpent, keys } =
    spendingBySource(buyer.state, state);
  return (
    <>
      <div className="preview-usage-grid">
        <section className="preview-panel" aria-label="Spending by source">
          <h3>Spending by source</h3>
          <div className="preview-panel-row">
            <span>
              {total === null
                ? 'Spending unavailable'
                : money(total) + ' spent'}
            </span>
            <span className="ui-help-text">Separate limits</span>
          </div>
          {total !== null ? (
            <SpendingBar segments={segments} total={total} />
          ) : (
            <div className="pk-segmented-track" aria-hidden="true" />
          )}
        </section>
        <section className="preview-panel" aria-label="Spending breakdown">
          <h3>Spending</h3>
          <div className="preview-panel-row">
            <span>Chat · current session</span>
            <strong>{money(chat)}</strong>
          </div>
          <div className="preview-panel-row">
            <span>API keys · lifetime</span>
            <strong>{money(keySpent)}</strong>
          </div>
          <div className="preview-panel-row">
            <span>Remaining · chat</span>
            <strong>
              {sameChat && summary.active && chat !== null
                ? money(BigInt(summary.limitAtomic) - chat)
                : sameChat
                  ? 'No active limit'
                  : 'Unavailable'}
            </strong>
          </div>
        </section>
      </div>
      <LimitControl
        key={policy?.policyId}
        buyer={buyer}
        policy={policy}
        open={(amount) => setReview({ policyId: policy?.policyId, amount })}
      />
      <KeyLimits snapshot={keys} manage={manage} />
      {review && review.policyId === policy?.policyId && (
        <Modal title="Chat budget" close={() => setReview(null)}>
          <X402Payments
            buyer={buyer}
            initialAmount={review.amount}
            onChat={onChat}
          />
        </Modal>
      )}
    </>
  );
}

function spendingBySource(
  buyerState: X402View['state'],
  state: ReturnType<typeof useUsdcApiKeys>['state'],
) {
  const { policy, summary, error } = buyerState;
  const sameChat =
    !!policy &&
    policy.mint === DEVNET_USDC &&
    !error &&
    summary.available &&
    !summary.blocked &&
    (!summary.policy || summary.policy.policyId === policy.policyId);
  const chat = sameChat ? BigInt(summary.spentAtomic) : null;
  const snapshot = state.snapshot;
  const keys =
    policy &&
    !state.error &&
    state.policyId === policy.policyId &&
    snapshot &&
    !snapshot.blocked &&
    snapshot.scope.mint === DEVNET_USDC &&
    snapshot.scope.mint === policy.mint &&
    snapshot.scope.payer === policy.payer &&
    snapshot.scope.network === policy.network
      ? snapshot
      : null;
  const keySpent = keys
    ? keys.keys.reduce((sum, entry) => sum + BigInt(entry.spentAtomic), 0n)
    : null;
  const total = chat !== null && keySpent !== null ? chat + keySpent : null;
  const segments: Segment[] =
    chat === null
      ? []
      : [{ id: 'chat', label: 'Chat', amount: chat, tone: TONE.INFO }];
  const active = keys?.keys.filter((entry) => !entry.revoked) ?? [];
  active.forEach((entry, i) =>
    segments.push({
      id: entry.id,
      label: entry.name,
      amount: BigInt(entry.spentAtomic),
      tone: i % 2 ? TONE.WARNING : TONE.SUCCESS,
    }),
  );
  const revoked =
    keys?.keys.reduce(
      (sum, entry) => sum + (entry.revoked ? BigInt(entry.spentAtomic) : 0n),
      0n,
    ) ?? 0n;
  if (revoked > 0n)
    segments.push({
      id: 'revoked',
      label: 'Revoked keys',
      amount: revoked,
      tone: TONE.NEUTRAL,
    });
  return { chat, policy, summary, sameChat, total, segments, keySpent, keys };
}

function parseLimit(policy: BuyerApiPolicy | null, value: string) {
  try {
    return policy ? BigInt(x402BudgetInput(value, policy)) : null;
  } catch {
    return null;
  }
}
