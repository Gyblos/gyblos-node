import { Info, Warning } from '@phosphor-icons/react';

import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';

import { sellerChannelStatus, type BuyerFunding } from '../funding/model';
import { fundingAmount } from './BuyerFunding';
import { BUTTON_VARIANT } from './constants';
import { DetailSummary, type DetailItem } from './DetailSummary';
import { FormActions } from './Form';
import { shortReference } from './history-presentation';
import { Modal } from './Modal';
import type { ModelOption } from './model-types';
import { TONE } from './status-tone';
import { Button } from './UI';
import { useBuyerFunding } from './useBuyerFunding';

type Policy = Pick<BuyerApiPolicy, 'payer' | 'maxAtomic'>;
export function SellerChannelReview({
  model,
  policy,
  close,
}: {
  model: ModelOption;
  policy?: Policy | null;
  close(): void;
}) {
  const { funding, loading, refresh } = useBuyerFunding(
    policy?.payer,
    model.offerId,
    !!model.offerId && !!policy,
  );
  return (
    <ChannelReviewDetails
      model={model}
      policy={policy}
      funding={funding}
      checking={!!policy && loading}
      refresh={refresh}
      close={close}
    />
  );
}
export function ChannelReviewDetails({
  model,
  policy,
  funding,
  checking,
  refresh,
  close,
  backLabel = 'Back to models',
}: {
  model: ModelOption;
  policy?: Policy | null;
  funding: BuyerFunding | null;
  checking: boolean;
  backLabel?: string;
  refresh(): void;
  close(): void;
}) {
  const status = sellerChannelStatus(funding);
  const ready = !checking && status.label === 'Ready';
  const Icon = ready ? Info : Warning;
  const rows: DetailItem[] = [
    {
      label: 'Current channel',
      value: funding?.channelId
        ? shortReference(funding.channelId)
        : 'Unavailable',
    },
    {
      label: 'Input / output per 1M tokens',
      value: model.input + ' / ' + model.output + ' USDC',
    },
  ];
  if (funding?.channelRemainingAtomic != null)
    rows.push({
      label: 'Remaining channel balance',
      value: fundingAmount(funding.channelRemainingAtomic),
    });
  if (
    funding?.balanceAtomic === null &&
    funding.lastBalanceAtomic !== undefined &&
    funding.lastBalanceAt !== undefined
  )
    rows.push({
      label: 'Last verified wallet balance',
      value:
        fundingAmount(funding.lastBalanceAtomic) +
        ' · ' +
        new Date(funding.lastBalanceAt).toLocaleString(),
    });
  if (funding?.channelBlocker === BUYER_KEY_CODES.REVIEW)
    rows.push(
      { label: 'Reserved by API key', value: 'Amount unavailable' },
      { label: 'Usage approval', value: 'Unconfirmed' },
      { label: 'Final settlement', value: 'Unconfirmed' },
    );
  return (
    <Modal title="Payment channel" close={close}>
      <div className="ui-form">
        <DetailSummary
          status={{
            label: checking ? 'Checking' : status.label,
            tone: ready ? TONE.SUCCESS : TONE.WARNING,
          }}
          meta={[model.name, model.family].filter(Boolean).join(' · ')}
          totals={[
            {
              label: 'Per-response limit',
              value: policy ? fundingAmount(policy.maxAtomic) : 'Unavailable',
            },
            {
              label: 'Wallet balance',
              value:
                funding?.balanceAtomic != null
                  ? fundingAmount(funding.balanceAtomic)
                  : 'Unavailable',
            },
          ]}
          rows={rows}
        />
        <p
          className="pk-notice"
          data-tone={ready ? TONE.NEUTRAL : TONE.WARNING}
          role="status"
        >
          <Icon size={15} weight="fill" aria-hidden="true" />
          <span>
            {checking
              ? 'Checking finalized channel status…'
              : status.description}
          </span>
        </p>
        <FormActions>
          {!checking && funding?.balanceAtomic == null && (
            <Button disabled={!policy} onClick={refresh}>
              Refresh wallet
            </Button>
          )}
          <Button onClick={close}>{backLabel}</Button>
          <Button
            variant={BUTTON_VARIANT.PRIMARY}
            disabled={!policy || checking}
            onClick={refresh}
          >
            Check status
          </Button>
        </FormActions>
      </div>
    </Modal>
  );
}
