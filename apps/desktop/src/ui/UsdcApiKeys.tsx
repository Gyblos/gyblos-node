// Buyer-owned USDC key management uses shared forms and financial facts; no wallet keys enter the view.
import { useState } from 'react';

import { DEVNET_USDC } from '@gyblos/config/network';
import {
  BUYER_API_KEYS,
  type BuyerKeyScope,
} from '@gyblos/protocol/buyer-api-keys';

import {
  USDC_API,
  USDC_API_ACTION,
  usdcApiKeyListDetail,
  type UsdcApiState,
} from '../usdc-api-model';
import { DESKTOP_X402, x402Asset, x402BudgetInput } from '../x402-model';
import { BUTTON_VARIANT } from './constants';
import { FormActions, FormField, FormInput } from './Form';
import { StatePanel } from './Management';
import { Button, List, ListRow, RowCopy } from './UI';
import { UsdcApiKeyDetails } from './UsdcApiKeyDetails';
import { useUsdcApiKeys } from './useUsdcApiKeys';
import { WorkspaceLayout } from './WorkspaceLayout';

type Controller = ReturnType<typeof useUsdcApiKeys>;
function keyLimit(value: string, scope: BuyerKeyScope) {
  try {
    return x402BudgetInput(value, scope);
  } catch {
    return null;
  }
}
function NewKey({
  create,
  disabled,
  scope,
}: {
  scope: BuyerKeyScope;
  create: (name: string, limit: string) => void;
  disabled: boolean;
}) {
  const [name, setName] = useState('Coding tools');
  const [limit, setLimit] = useState<string>(
    scope.mint === DEVNET_USDC ? USDC_API.DEFAULT_LIMIT : '0',
  );
  const atomic = keyLimit(limit, scope);
  const valid =
    atomic !== null && !!name.trim() && name.length <= BUYER_API_KEYS.MAX_NAME;
  return (
    <section className="ui-section" aria-label="Create USDC API key">
      <h2>Create an API key</h2>
      <div className="ui-form ui-form--limited">
        <FormField label="Name" htmlFor="usdc-key-name">
          <FormInput
            id="usdc-key-name"
            value={name}
            maxLength={BUYER_API_KEYS.MAX_NAME}
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
          />
        </FormField>
        <FormField
          label={`Spend limit · ${x402Asset(scope)}`}
          htmlFor="usdc-key-limit"
        >
          <FormInput
            id="usdc-key-limit"
            type="number"
            min="0"
            step={
              scope.mint === DEVNET_USDC ? 1 / DESKTOP_X402.AMOUNT_SCALE : 1
            }
            value={limit}
            disabled={disabled}
            aria-invalid={atomic === null}
            onChange={(event) => setLimit(event.target.value)}
          />
        </FormField>
        <p className="ui-help-text">
          Total for this key. Shared across tools, saved on this computer, with
          no automatic reset. A zero limit allows free models only.
        </p>
        <FormActions align="start">
          <Button
            variant={BUTTON_VARIANT.PRIMARY}
            disabled={disabled || !valid}
            onClick={() => {
              if (valid && atomic !== null) create(name.trim(), atomic);
            }}
          >
            Create API key
          </Button>
        </FormActions>
      </div>
    </section>
  );
}
function KeyList({
  state,
  selected,
  onSelect,
}: {
  state: UsdcApiState;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  if (!state.snapshot?.keys.length) return null;
  return (
    <section className="ui-section" aria-label="Saved API keys">
      <h2>Your API keys</h2>
      <List label="Saved API keys">
        {state.snapshot.keys.map((key) => (
          <ListRow
            key={key.id}
            leading={null}
            trailing={
              <Button
                aria-pressed={selected === key.id}
                onClick={() => onSelect(key.id)}
              >
                {selected === key.id ? 'Selected' : 'View'}
              </Button>
            }
          >
            <RowCopy
              title={key.name}
              detail={usdcApiKeyListDetail(state, key)}
            />
          </ListRow>
        ))}
      </List>
    </section>
  );
}
function UsdcKeyContext({
  onPayments,
  scope,
}: {
  onPayments: () => void;
  scope: BuyerKeyScope | undefined;
}) {
  return (
    <>
      <section className="ui-context-section">
        <h3>Payment method</h3>
        <strong>{scope ? x402Asset(scope) : 'USDC'}</strong>
        <p className="ui-help-text">
          Key usage is separate from Chat. Existing buyer and session limits
          still apply.
        </p>
        <Button onClick={onPayments}>View payments</Button>
      </section>
      <section className="ui-context-section">
        <h3>Access</h3>
        <p className="ui-help-text">
          This computer · Keep Gyblos open. The key permission and consumption
          survive a restart.
        </p>
      </section>
    </>
  );
}
function ConfiguredKeys({
  api,
  selectedId,
  onSelect,
  onPayments,
}: {
  api: Controller;
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onPayments: () => void;
}) {
  const { state, busy, run } = api;
  if (!state.snapshot) return null;
  return (
    <>
      {state.snapshot.blocked && (
        <StatePanel
          title="Spending needs review"
          description="A previous operation is unresolved. New requests and new keys stay blocked; revocation preserves the recorded obligation."
          action={<Button onClick={onPayments}>Review payments</Button>}
        />
      )}
      {selectedId && (
        <UsdcApiKeyDetails key={selectedId} api={api} id={selectedId} />
      )}
      <NewKey
        scope={state.snapshot.scope}
        disabled={
          busy ||
          !!state.error ||
          state.snapshot.blocked ||
          state.snapshot.keys.length >= BUYER_API_KEYS.MAX_KEYS
        }
        create={(name, limitAtomic) => {
          void run({
            action: USDC_API_ACTION.CREATE,
            name,
            limitAtomic,
          }).then((result) => {
            if (result?.snapshot && !result.error)
              onSelect(result.snapshot.keys.at(-1)?.id);
          });
        }}
      />
      <KeyList state={state} selected={selectedId} onSelect={onSelect} />
    </>
  );
}
export function UsdcApiKeys({
  onPayments,
  contextOpen,
  onCloseContext,
}: {
  onPayments: () => void;
  contextOpen: boolean;
  onCloseContext: () => void;
}) {
  const api = useUsdcApiKeys();
  const { state, busy, run } = api;
  const [selected, setSelected] = useState<string>();
  const selectedId = state.snapshot?.keys.some((key) => key.id === selected)
    ? selected
    : (state.snapshot?.keys.find((key) => !key.revoked)?.id ??
      state.snapshot?.keys.at(-1)?.id);

  return (
    <WorkspaceLayout
      context={
        <UsdcKeyContext onPayments={onPayments} scope={state.snapshot?.scope} />
      }
      contextOpen={contextOpen}
      onCloseContext={onCloseContext}
    >
      <div className="ui-connection-page">
        {!state.snapshot ? (
          <StatePanel
            title="Connect your USDC buyer"
            description="Start the local buyer in Payments, then create a bounded API key here."
            action={
              <Button variant={BUTTON_VARIANT.PRIMARY} onClick={onPayments}>
                Go to Payments
              </Button>
            }
          />
        ) : (
          <>
            <ConfiguredKeys
              api={api}
              selectedId={selectedId}
              onSelect={setSelected}
              onPayments={onPayments}
            />
          </>
        )}
        {state.error && (
          <p className="chat-notice" role="alert">
            {state.error}
          </p>
        )}
        <FormActions align="start">
          <Button
            disabled={busy}
            onClick={() => {
              void run({ action: USDC_API_ACTION.STATUS });
            }}
          >
            Refresh
          </Button>
        </FormActions>
      </div>
    </WorkspaceLayout>
  );
}
