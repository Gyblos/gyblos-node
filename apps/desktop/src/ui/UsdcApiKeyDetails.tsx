// Connection fields and immutable key budget use shared buyer primitives; secrets copy only in the host.
import { useState } from 'react';

import type {
  BuyerApiKeySummary,
  BuyerKeyScope,
} from '@gyblos/protocol/buyer-api-keys';

import { usdcApiAmount as amount, USDC_API_ACTION } from '../usdc-api-model';
import { BuyerAgentSetup } from './BuyerAgentSetup';
import { BUTTON_VARIANT } from './constants';
import { CopyField, FormActions } from './Form';
import { Facts, Pair } from './Management';
import { Modal } from './Modal';
import { Badge, Button } from './UI';
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
  return (
    <>
      <Facts compact>
        <Pair label="Spend limit" value={amount(key.limitAtomic, scope)} />
        <Pair
          label="Consumed budget"
          value={known ? amount(key.spentAtomic, scope) : 'Needs review'}
        />
        <Pair
          label="Remaining"
          value={
            known
              ? amount(
                  String(
                    BigInt(key.limitAtomic) -
                      BigInt(key.spentAtomic) -
                      BigInt(key.reservedAtomic),
                  ),
                  scope,
                )
              : 'Unavailable'
          }
        />
      </Facts>
      <p className="ui-help-text">
        {!known ? (
          'Recorded amounts need review.'
        ) : (
          <>
            {amount(key.settledAtomic, scope)} settled ·{' '}
            {amount(key.approvedAtomic, scope)} approved ·{' '}
            {amount(key.reservedAtomic, scope)} reserved. Approved usage is not
            a settled payment.
          </>
        )}
      </p>
    </>
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
    <Modal title="Revoke API key?" close={close}>
      <p>
        Stops new requests from every tool using this key. An inference already
        sent can still count. Its consumption and pending reservations stay
        recorded.
      </p>
      <FormActions>
        <Button onClick={close}>Keep key</Button>
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
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
      <div className="ui-section-title">
        <h2>{key.name}</h2>
        <Badge>
          {key.revoked
            ? 'Revoked'
            : state.snapshot?.blocked
              ? 'Needs review'
              : key.spentAtomic === key.limitAtomic
                ? 'Paid limit reached'
                : 'Active'}
        </Badge>
      </div>
      <CopyField
        id="usdc-tool-key"
        label="API key"
        secret
        value="Key saved in your tool"
        actionLabel="Copy API key"
        disabled={busy || !available}
        onCopy={() => {
          void run({ action: USDC_API_ACTION.COPY_KEY, id });
        }}
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
