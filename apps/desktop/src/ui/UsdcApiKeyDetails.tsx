// Connection fields and immutable key budget use shared buyer primitives; secrets copy only in the host.
import { useState } from 'react';

import type {
  BuyerApiKeySummary,
  BuyerKeyScope,
} from '@gyblos/protocol/buyer-api-keys';

import { RESPONSE_METRICS } from '../constants';
import {
  usdcApiAmount as amount,
  USDC_API_ACTION,
  usdcApiKeyBadge,
} from '../usdc-api-model';
import { x402Asset } from '../x402-model';
import { BuyerAgentSetup } from './BuyerAgentSetup';
import { DetailSummary } from './DetailSummary';
import { CopyField, FormActions } from './Form';
import { Modal } from './Modal';
import { statusTone } from './status-tone';
import { Button } from './UI';
import { UsdcApiKeyField } from './UsdcApiKeyField';
import type { useUsdcApiKeys } from './useUsdcApiKeys';

type Controller = ReturnType<typeof useUsdcApiKeys>;
function KeyUsage({
  keyStatus: key,
  scope,
  known,
}: {
  keyStatus: BuyerApiKeySummary;
  scope: BuyerKeyScope;
  known: boolean;
}) {
  if (!known) return <p role="status">Recorded amounts need review.</p>;
  const spent = BigInt(key.spentAtomic);
  const reserved = BigInt(key.reservedAtomic);
  const limit = BigInt(key.limitAtomic);
  return (
    <div className="preview-key-budget">
      <div>
        <span>
          <strong>{amount(key.spentAtomic, scope)}</strong> used of{' '}
          {amount(key.limitAtomic, scope)}
        </span>
        <span>{amount(String(limit - spent - reserved), scope)} available</span>
      </div>
      {limit > 0n && (
        <progress
          aria-label="Budget consumed"
          max={RESPONSE_METRICS.PERCENT_SCALE}
          value={
            (Number(spent) / Number(limit)) * RESPONSE_METRICS.PERCENT_SCALE
          }
        />
      )}
      {(reserved > 0n ||
        BigInt(key.approvedAtomic) > 0n ||
        BigInt(key.settledAtomic) > 0n) && (
        <small>
          {amount(key.settledAtomic, scope)} settled ·{' '}
          {amount(key.approvedAtomic, scope)} approved ·{' '}
          {amount(key.reservedAtomic, scope)} reserved.
        </small>
      )}
    </div>
  );
}
function RevokeConfirmation({
  id,
  close,
  run,
}: {
  id: string;
  close: () => void;
  run: Controller['run'];
}) {
  return (
    <Modal title="Revoke API key?" size="sm" close={close}>
      <p>
        Stops new requests from every tool using this key. An inference already
        sent can still count. Its consumption and pending reservations stay
        recorded.
      </p>
      <FormActions>
        <Button onClick={close}>Keep key</Button>
        <Button
          className="preview-destructive"
          onClick={() => {
            close();
            void run({ action: USDC_API_ACTION.REVOKE, id });
          }}
        >
          Revoke key
        </Button>
      </FormActions>
    </Modal>
  );
}
function KeyActions({
  api,
  id,
  known,
  revoked,
  revoke,
}: {
  api: Controller;
  id: string;
  known: boolean;
  revoked: boolean;
  revoke: () => void;
}) {
  const { busy, run } = api;
  return (
    <FormActions align="start">
      <BuyerAgentSetup api={api} id={id} disabled={busy || !known || revoked} />
      <Button
        disabled={busy || !known || revoked}
        onClick={() => {
          void run({ action: USDC_API_ACTION.COPY_EXAMPLE, id });
        }}
      >
        Copy API example
      </Button>
      <Button disabled={busy || revoked} onClick={revoke}>
        Revoke key
      </Button>
    </FormActions>
  );
}

export function UsdcApiKeyDetails({
  api,
  id,
}: {
  api: Controller;
  id: string;
}) {
  const { state, busy, run } = api;
  const [confirm, setConfirm] = useState(false);
  const scope = state.snapshot?.scope;
  const key = state.snapshot?.keys.find((key) => key.id === id);
  if (!key || !state.url || !scope) return null;
  const known = !state.error && !state.snapshot?.blocked;
  const available = known && !key.revoked && state.copyable.includes(key.id);
  return (
    <section className="ui-section" aria-label="USDC API connection">
      <KeySummary
        keyStatus={key}
        scope={scope}
        known={known}
        status={usdcApiKeyBadge(state, key)}
      />
      <UsdcApiKeyField
        key={id + state.policyId}
        api={api}
        id={id}
        available={available}
      />
      {!state.copyable.includes(key.id) && !key.revoked && (
        <p className="ui-help-text">
          The secret is available only in the app session that created it. A key
          already saved in your tool keeps its original limit after restart.
        </p>
      )}
      <CopyField
        id="usdc-tool-url"
        label="Base URL"
        value={state.url}
        actionLabel="Copy Base URL"
        disabled={busy || !known || key.revoked}
        onCopy={() => {
          void run({ action: USDC_API_ACTION.COPY_URL, id });
        }}
      />
      <KeyUsage keyStatus={key} scope={scope} known={known} />
      <KeyActions
        api={api}
        id={id}
        known={known}
        revoked={key.revoked}
        revoke={() => setConfirm(true)}
      />
      <p className="ui-help-text">
        OpenAI Chat Completions, Responses and Anthropic Messages use the same
        buyer and its configured models. Unsupported options are refused before
        sending the prompt.
      </p>
      {confirm && (
        <RevokeConfirmation id={id} close={() => setConfirm(false)} run={run} />
      )}
    </section>
  );
}

function KeySummary({
  keyStatus: key,
  scope,
  known,
  status,
}: {
  keyStatus: BuyerApiKeySummary;
  scope: BuyerKeyScope;
  known: boolean;
  status: string;
}) {
  return (
    <DetailSummary
      status={{
        label: status,
        tone: statusTone(status),
      }}
      meta={'API key · ' + x402Asset(scope)}
      totals={[
        {
          label: 'Used',
          value: known ? amount(key.spentAtomic, scope) : 'Needs review',
        },
        { label: 'Limit', value: amount(key.limitAtomic, scope) },
        {
          label: 'Available',
          value: known
            ? amount(
                String(
                  BigInt(key.limitAtomic) -
                    BigInt(key.spentAtomic) -
                    BigInt(key.reservedAtomic),
                ),
                scope,
              )
            : 'Unavailable',
        },
      ]}
    />
  );
}
