// Desktop chat permission and verified receipts, distinct from the protected desktop wallet.
import { useState } from 'react';

import { LOCALHOST, PORTS } from '@gyblos/config/hosts';
import { ROUTES } from '@gyblos/config/paths';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

import {
  DESKTOP_X402,
  X402_ACTION,
  x402Amount,
  x402Asset,
  x402BudgetInput,
  x402Explorer,
} from '../x402-model';
import { BUTTON_VARIANT } from './constants';
import { DataCell, DataTable } from './DataTable';
import { CopyField, FormActions, FormField, FormInput } from './Form';
import { HISTORY } from './history-constants';
import { Modal } from './Modal';
import { Pagination } from './Pagination';
import { Badge, Button } from './UI';
import type { X402View } from './useX402';

export function X402Payments({
  buyer,
  onChat,
}: {
  buyer: X402View;
  onChat(): void;
}) {
  const { summary, policy } = buyer.state;
  const activePolicy = summary.policy ?? policy;
  const [copyError, setCopyError] = useState('');
  const copy = (
    action: typeof X402_ACTION.COPY_PAYER | typeof X402_ACTION.COPY_MINT,
  ) => {
    void buyer
      .run({ action })
      .then((result) =>
        setCopyError(result && !result.error ? '' : 'Copy unavailable'),
      );
  };
  return (
    <section className="ui-form" aria-label="x402 chat budget">
      <div className="ui-toolbar">
        <h2>Chat budget · x402</h2>
        <Badge>Solana devnet</Badge>
      </div>
      {!policy && <X402Connection buyer={buyer} />}
      {activePolicy && (
        <div className="ui-form">
          <p>
            {activePolicy.model} · {x402Asset(activePolicy)}
          </p>
          <CopyField
            id="x402-payer"
            actionLabel="Copy paying wallet address"
            label="Paying wallet"
            value={activePolicy.payer}
            onCopy={() => copy(X402_ACTION.COPY_PAYER)}
          />
          <CopyField
            id="x402-mint"
            actionLabel="Copy token mint"
            label="Token mint"
            value={activePolicy.mint}
            onCopy={() => copy(X402_ACTION.COPY_MINT)}
          />
        </div>
      )}
      {summary.active && activePolicy ? (
        <X402ActiveBudget buyer={buyer} policy={activePolicy} onChat={onChat} />
      ) : (
        policy && <X402Authorize buyer={buyer} policy={policy} />
      )}
      {(buyer.state.error || copyError || summary.blocked) && (
        <p role="status">
          {copyError ||
            buyer.state.error ||
            'An unfinished payment needs review. New messages are blocked.'}
        </p>
      )}
      <X402History buyer={buyer} />
    </section>
  );
}

function X402Connection({ buyer }: { buyer: X402View }) {
  const [relayToken, setRelayToken] = useState('');
  const [external, setExternal] = useState(false);
  return (
    <div className="ui-form">
      <form
        className="ui-form"
        onSubmit={(event) => {
          event.preventDefault();
          void buyer
            .run({ action: X402_ACTION.START_BUYER, relayToken })
            .then((result) => {
              if (result?.policy) setRelayToken('');
            });
        }}
      >
        <p>Use the same buyer configuration as the Gyblos CLI.</p>
        <FormActions align="start">
          <Button
            disabled={buyer.busy}
            onClick={() => {
              void buyer.run({ action: X402_ACTION.CHOOSE_HOME });
            }}
          >
            {buyer.state.homeSelected
              ? 'Change configuration folder'
              : 'Choose configuration folder'}
          </Button>
          {buyer.state.homeSelected && <Badge>Selected</Badge>}
        </FormActions>
        <p>Select the GYBLOS_HOME folder containing buyer/selection.json.</p>
        <FormField htmlFor="x402-relay-token" label="Relay token">
          <FormInput
            id="x402-relay-token"
            type="password"
            autoComplete="off"
            value={relayToken}
            onChange={(event) => setRelayToken(event.target.value)}
          />
        </FormField>
        <p>Leave blank to use GYBLOS_RELAY_TOKEN from the app environment.</p>
        <FormActions align="start">
          <Button
            type="submit"
            variant={BUTTON_VARIANT.PRIMARY}
            disabled={buyer.busy || !buyer.state.homeSelected}
          >
            {buyer.busy ? 'Starting buyer…' : 'Start local buyer'}
          </Button>
          <Button disabled={buyer.busy} onClick={() => setExternal(true)}>
            Connect a running buyer
          </Button>
        </FormActions>
      </form>
      {external && (
        <Modal title="Connect a running buyer" close={() => setExternal(false)}>
          <X402ExternalConnection buyer={buyer} />
        </Modal>
      )}
    </div>
  );
}
function X402ExternalConnection({ buyer }: { buyer: X402View }) {
  const [url, setUrl] = useState(
    'http://' + LOCALHOST + ':' + PORTS.buyerProxy + ROUTES.inference,
  );
  const [token, setToken] = useState('');
  return (
    <form
      className="ui-form"
      onSubmit={(event) => {
        event.preventDefault();
        void buyer
          .run({ action: X402_ACTION.CONNECT, url, token })
          .then((result) => {
            if (result?.policy) setToken('');
          });
      }}
    >
      <p>Connect the local Gyblos buyer to use your existing seller.</p>
      <FormField htmlFor="x402-url" label="Local buyer URL">
        <FormInput
          id="x402-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </FormField>
      <FormField htmlFor="x402-key" label="Buyer API key">
        <FormInput
          id="x402-key"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </FormField>
      <FormActions align="start">
        <Button
          type="submit"
          disabled={buyer.busy || !token}
          variant={BUTTON_VARIANT.SECONDARY}
        >
          Connect buyer
        </Button>
      </FormActions>
    </form>
  );
}

function X402Authorize({
  buyer,
  policy,
}: {
  buyer: X402View;
  policy: BuyerApiPolicy;
}) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      className="ui-form"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          setError('');
          const limitAtomic = x402BudgetInput(amount, policy);
          void buyer.run({ action: X402_ACTION.AUTHORIZE, limitAtomic });
        } catch (failure) {
          setError(
            failure instanceof Error ? failure.message : 'Enter a valid budget',
          );
        }
      }}
    >
      <FormField
        htmlFor="x402-budget"
        label={'Chat budget · ' + x402Asset(policy)}
      >
        <FormInput
          id="x402-budget"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </FormField>
      <p>
        Maximum per response: {x402Amount(policy.maxAtomic, policy)}. This
        permission applies to Chat on this device.
      </p>
      {error && <p role="status">{error}</p>}
      <FormActions align="start">
        <Button
          type="submit"
          disabled={buyer.busy || buyer.state.summary.blocked || !amount}
          variant={BUTTON_VARIANT.PRIMARY}
        >
          Authorize budget
        </Button>
      </FormActions>
    </form>
  );
}

function X402ActiveBudget({
  buyer,
  policy,
  onChat,
}: {
  buyer: X402View;
  policy: BuyerApiPolicy;
  onChat(): void;
}) {
  const { summary } = buyer.state;
  return (
    <>
      <dl className="ui-stats">
        <div>
          <dt>Chat budget</dt>
          <dd>{x402Amount(summary.limitAtomic, policy)}</dd>
        </div>
        <div>
          <dt>Confirmed spending</dt>
          <dd>{x402Amount(summary.spentAtomic, policy)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>
            {summary.blocked
              ? 'Under review'
              : x402Amount(
                  String(
                    BigInt(summary.limitAtomic) - BigInt(summary.spentAtomic),
                  ),
                  policy,
                )}
          </dd>
        </div>
      </dl>
      <FormActions align="start">
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={
            buyer.busy ||
            summary.blocked ||
            buyer.state.policy?.policyId !== summary.policy?.policyId
          }
          onClick={onChat}
        >
          Continue in Chat
        </Button>
        <Button
          disabled={buyer.busy || summary.blocked}
          onClick={() => {
            void buyer.run({ action: X402_ACTION.FINISH });
          }}
        >
          Finish session
        </Button>
      </FormActions>
      <p>
        Each response settles automatically. Finishing closes this app’s
        permission to spend.
      </p>
    </>
  );
}

export function X402History({ buyer }: { buyer: X402View }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(HISTORY.PAGE_SIZES[0]);
  const records = buyer.state.summary.records.slice().reverse();
  const current = Math.min(page, Math.max(1, Math.ceil(records.length / size)));
  return records.length ? (
    <section aria-label="x402 payments" className="ui-form">
      <h3>x402 payments · Chat</h3>
      <DataTable
        caption="Verified x402 chat payments"
        headings={['Date', 'Usage', 'Amount', 'Payment ID']}
      >
        {records.slice((current - 1) * size, current * size).map((record) => (
          <tr key={record.id} role="row">
            <DataCell label="Date">
              {new Date(record.at).toLocaleString()}
            </DataCell>
            <DataCell label="Usage">
              <strong>
                {record.free ? 'Free response' : 'Confirmed payment'}
              </strong>
              <span className="ui-muted">{record.policy.model}</span>
            </DataCell>
            <DataCell label="Amount">
              <strong>
                {record.free
                  ? '0'
                  : '−' + x402Amount(record.chargeAtomic, record.policy)}
              </strong>
              <span className="ui-muted">{x402Asset(record.policy)}</span>
            </DataCell>
            <DataCell label="Payment ID">
              {record.transaction ? (
                <a
                  href={x402Explorer(record.transaction)}
                  onClick={(event) => {
                    event.preventDefault();
                    void buyer.run({
                      action: X402_ACTION.EXPLORER,
                      id: record.id,
                    });
                  }}
                  aria-label="View payment in Solana explorer"
                >
                  {record.transaction.slice(0, DESKTOP_X402.SIGNATURE_PREFIX) +
                    '…' +
                    record.transaction.slice(-DESKTOP_X402.SIGNATURE_SUFFIX)}
                </a>
              ) : (
                '—'
              )}
            </DataCell>
          </tr>
        ))}
      </DataTable>
      <Pagination
        label="x402 payment pagination"
        page={current}
        pageSize={size}
        total={records.length}
        onPage={setPage}
        onPageSize={(value) => {
          setSize(value);
          setPage(1);
        }}
      />
    </section>
  ) : null;
}
