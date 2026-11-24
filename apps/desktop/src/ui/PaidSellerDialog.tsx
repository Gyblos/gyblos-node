// The first paid message opens the channel after the selected seller and maximum are confirmed.
import { useState } from 'react';

import {
  BATCH_SESSION_DEFAULTS,
  BUYER_SESSION_DEFAULT_POLICY,
} from '@gyblos/config/batch-session';
import { MILLISECONDS_PER_MINUTE } from '@gyblos/config/constants';
import { atomicToUsdc, usdcToAtomic } from '@gyblos/node/node-config-price';

import { depositShortfall, sellerResponseLimit } from '../funding/model';
import { paidSellerLimitNotice, X402_ACTION } from '../x402-model';
import { fundingAmount } from './BuyerFunding';
import { BUTTON_VARIANT } from './constants';
import { FormField, FormInput } from './Form';
import { Modal } from './Modal';
import { usdPerMtok } from './model-price';
import type { CatalogModel } from './model-types';
import { Button } from './UI';
import { useBuyerFunding } from './useBuyerFunding';
import type { X402View } from './useX402';

function useSellerConfirmation(
  model: CatalogModel,
  buyer: X402View,
  confirm: (id: string) => void,
  availableMaximum?: string,
) {
  const { policy } = buyer.state;
  const [maximum, setMaximum] = useState(() =>
    policy && policy.maxAtomic !== '0'
      ? atomicToUsdc(BigInt(policy.maxAtomic))
      : '',
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function select() {
    let maxAtomic: string;
    try {
      maxAtomic = String(usdcToAtomic(maximum));
      if (maxAtomic === '0') throw new Error();
    } catch {
      setError('Enter a positive USDC maximum with up to six decimal places.');
      return;
    }
    if (
      availableMaximum !== undefined &&
      BigInt(maxAtomic) > BigInt(availableMaximum)
    ) {
      setError(
        'Choose a maximum up to ' +
          fundingAmount(availableMaximum) +
          ' for this channel.',
      );
      return;
    }
    setSaving(true);
    try {
      const result =
        policy?.maxAtomic === maxAtomic &&
        policy.depositAtomic &&
        policy.lifetimeMs
          ? { policy, summary: buyer.state.summary, error: undefined }
          : await buyer.run({
              action: X402_ACTION.CONFIGURE_PAID,
              maxAtomic,
              ...(policy ? { policyId: policy.policyId } : {}),
            });
      if (!result?.policy || result.error) {
        setError(
          result?.error ?? 'Could not apply the spending maximum. Try again.',
        );
        return;
      }
      const notice = paidSellerLimitNotice(
        result.policy,
        result.summary,
        model.name,
      );
      if (
        result.policy.depositAtomic !==
          (policy?.depositAtomic ??
            BUYER_SESSION_DEFAULT_POLICY.depositAtomic) ||
        result.policy.lifetimeMs !==
          (policy?.lifetimeMs ?? BUYER_SESSION_DEFAULT_POLICY.lifetimeMs)
      )
        setError(
          'The channel terms were updated. Review them and confirm the seller.',
        );
      else if (notice) setError(notice);
      else confirm(result.policy.policyId);
    } finally {
      setSaving(false);
    }
  }
  return { maximum, setMaximum, error, setError, saving, select };
}
interface SellerDialogProps {
  model: CatalogModel;
  buyer: X402View;
  close(): void;
  confirm(policyId: string): void;
}
export function PaidSellerDialog(
  props: SellerDialogProps & { addFunds(): void },
) {
  const policy = props.buyer.state.policy;
  const { funding, loading, refresh } = useBuyerFunding(
    policy?.payer,
    props.model.offerId,
  );
  // A legacy profile must acquire valid channel settings before its payer can be verified.
  if (!policy) return <SellerTerms {...props} confirm={refresh} />;
  const remaining = funding?.channelRemainingAtomic;
  if (
    funding?.poolLimited ||
    (funding?.replacementAtomic != null &&
      BigInt(funding.replacementAtomic) <
        BigInt(BATCH_SESSION_DEFAULTS.minDepositAtomic))
  )
    return (
      <MinimumDepositNotice
        close={props.close}
        deposit={funding?.poolLimited ? policy.depositAtomic : undefined}
      />
    );
  if (remaining === '0')
    return <UsedChannelNotice close={props.close} refresh={refresh} />;
  const hasEscrow =
    (remaining != null && BigInt(remaining) > 0n) || !!funding?.switchingAtomic;
  const balance = funding?.balanceAtomic;
  if (!hasEscrow && (loading || balance == null))
    return (
      <Modal title="Buyer wallet balance" close={props.close}>
        <div className="ui-form">
          <p role="status">
            {loading
              ? 'Checking available USDC…'
              : 'Could not check the buyer wallet balance.'}
          </p>
          <Button disabled={loading} onClick={refresh}>
            Refresh balance
          </Button>
        </div>
      </Modal>
    );
  const deposit =
    funding?.replacementAtomic ??
    policy.depositAtomic ??
    BUYER_SESSION_DEFAULT_POLICY.depositAtomic;
  const missing = balance == null ? null : depositShortfall(balance, deposit);
  if (!hasEscrow && missing && missing !== '0' && balance != null)
    return (
      <Modal title="Insufficient balance" close={props.close}>
        <div className="ui-form">
          <p>
            Your balance is {fundingAmount(balance)}. Add{' '}
            {fundingAmount(missing)} to open a channel with this seller.
          </p>
          <Button variant={BUTTON_VARIANT.PRIMARY} onClick={props.addFunds}>
            Add funds
          </Button>
        </div>
      </Modal>
    );
  return (
    <SellerTerms
      {...props}
      remaining={remaining ?? undefined}
      switching={funding?.switchingAtomic}
      replacement={funding?.replacementAtomic}
      availableMaximum={sellerResponseLimit(funding, deposit)}
    />
  );
}
function SellerTerms({
  model,
  buyer,
  close,
  confirm,
  remaining,
  switching,
  availableMaximum,
  replacement,
}: SellerDialogProps & {
  remaining?: string;
  switching?: string;
  replacement?: string;
  availableMaximum?: string;
}) {
  const { maximum, setMaximum, error, setError, saving, select } =
    useSellerConfirmation(model, buyer, confirm, availableMaximum);
  const { policy } = buyer.state;
  const deposit =
    replacement ??
    policy?.depositAtomic ??
    BUYER_SESSION_DEFAULT_POLICY.depositAtomic;
  const minutes =
    (policy?.lifetimeMs ?? BUYER_SESSION_DEFAULT_POLICY.lifetimeMs) /
    MILLISECONDS_PER_MINUTE;
  return (
    <Modal
      title="Confirm seller"
      close={() => {
        if (!saving) close();
      }}
    >
      <form
        className="ui-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!buyer.busy && !saving) void select();
        }}
      >
        <div>
          <strong>{model.name}</strong>
          <p>{model.family}</p>
        </div>
        <FormField
          htmlFor="paid-response-maximum"
          label="Maximum per response (USDC)"
        >
          <FormInput
            id="paid-response-maximum"
            inputMode="decimal"
            placeholder="0.00"
            value={maximum}
            onChange={(event) => {
              setMaximum(event.target.value);
              setError('');
            }}
          />
        </FormField>
        <ChannelTerms
          switching={switching}
          remaining={remaining}
          deposit={deposit}
          minutes={minutes}
        />
        <SellerRates model={model} />
        {error && <p role="alert">{error}</p>}
        <Button
          type="submit"
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={!maximum || saving || buyer.busy}
        >
          {saving ? 'Saving…' : 'Confirm seller'}
        </Button>
      </form>
    </Modal>
  );
}

function ChannelTerms({
  switching,
  remaining,
  deposit,
  minutes,
}: {
  switching?: string;
  remaining?: string;
  deposit: string;
  minutes: number;
}) {
  return switching ? (
    <p>
      Sending your first message will close the previous seller’s channel and
      open this one with up to {fundingAmount(switching)} from the refund.
    </p>
  ) : remaining ? (
    <p>
      Your existing channel has {fundingAmount(remaining)} available. If it
      needs replacing before your message, the new deposit can be up to{' '}
      {fundingAmount(deposit)} for {minutes} minutes.{' '}
    </p>
  ) : (
    <p>
      Sending your first message settles any previous single-seller channel
      before opening this one with a {atomicToUsdc(BigInt(deposit))} USDC
      deposit for {minutes} minutes.
    </p>
  );
}

function SellerRates({ model }: { model: CatalogModel }) {
  return (
    <details>
      <summary>Seller rates</summary>
      <p>
        {usdPerMtok(model.input)} input · {usdPerMtok(model.output)} output per
        1M tokens
      </p>
    </details>
  );
}
function MinimumDepositNotice({
  close,
  deposit,
}: {
  close: () => void;
  deposit?: string;
}) {
  return (
    <Modal title="Channel spending limit reached" close={close}>
      <p>
        The remaining spending allowance is below the required deposit of{' '}
        {fundingAmount(deposit ?? BATCH_SESSION_DEFAULTS.minDepositAtomic)} for
        a new channel.
      </p>
    </Modal>
  );
}

function UsedChannelNotice({
  close,
  refresh,
}: {
  close(): void;
  refresh(): void;
}) {
  return (
    <Modal title="Channel balance used" close={close}>
      <div className="ui-form">
        <p>
          This channel has used its deposit. Review its settlement in Payments
          or check its balance again.
        </p>
        <Button onClick={refresh}>Refresh balance</Button>
      </div>
    </Modal>
  );
}
