import { Check, PushPin, Shuffle } from '@phosphor-icons/react';
import { useState } from 'react';

import { BUTTON_VARIANT } from './constants';
import { ChoiceMenu } from './Management';
import { Modal } from './Modal';
import type { ModelOption } from './model-types';
import { OfferTable } from './OfferTable';
import { SellerChannelReview } from './SellerChannelReview';
import { lowestRate } from './SellerStrategies';
import { TONE } from './status-tone';
import { Tag } from './Tag';
import { Button, SearchField } from './UI';

type Props = {
  name: string;
  policy?: Pick<
    import('@gyblos/protocol/buyer-api').BuyerApiPolicy,
    'payer' | 'maxAtomic'
  > | null;
  offers: readonly ModelOption[];
  selected: string;
  automatic: boolean;
  auto?: () => void;
  choose(id: string): void;
  close(): void;
};
export function CatalogSellerDialog({
  name,
  offers,
  policy,
  selected,
  automatic,
  auto,
  choose,
  close,
}: Props) {
  const [offerId, setOfferId] = useState<string>(() =>
    !automatic && offers.some((o) => o.id === selected) ? selected : '',
  );
  const [strategy, setStrategy] = useState<'Auto' | 'Cheapest'>(() =>
    auto ? 'Auto' : 'Cheapest',
  );
  const [reviewId, setReviewId] = useState<string>();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'Price' | 'Seller'>('Price');
  const manual = offers.find((o) => o.id === offerId);
  const expired = Boolean(offerId && !manual);
  const cheapest = lowestRate(offers);
  const choice = manual ?? (strategy === 'Cheapest' ? cheapest : undefined);
  const filtered = matchingOffers(offers, name, sort, query);
  const review = reviewId
    ? offers.find((offer) => offer.offerId === reviewId && !offer.free)
    : undefined;
  const target = choice ?? (offers.length === 1 ? offers[0] : undefined);
  if (review)
    return <SellerChannelReview model={review} policy={policy} close={close} />;
  return (
    <Modal title={name} size="lg" close={close}>
      <div className="preview-seller-drawer">
        <CatalogSellerActions
          offers={offers}
          target={target}
          choice={choice}
          expired={expired}
          auto={auto}
          choose={choose}
          review={setReviewId}
        />
        <StrategyControls
          manual={manual}
          expired={expired}
          choice={choice}
          strategy={strategy}
          automaticAvailable={!!auto}
          change={(value) => {
            setOfferId('');
            setStrategy(value);
          }}
        />
        <div className="ui-toolbar">
          <SearchField
            label="Search sellers"
            placeholder="Search sellers or quantization"
            value={query}
            onValueChange={setQuery}
          />
          <ChoiceMenu
            label="Sort sellers"
            value={sort}
            options={['Price', 'Seller']}
            onChange={setSort}
          />
        </div>
        <OfferTable
          name={name}
          offers={filtered}
          selected={choice?.id}
          choose={setOfferId}
          icon={Check}
        />
      </div>
    </Modal>
  );
}

function CatalogSellerActions(
  props: Pick<Props, 'offers' | 'auto' | 'choose'> & {
    target?: ModelOption;
    choice?: ModelOption;
    expired: boolean;
    review(id?: string): void;
  },
) {
  return (
    <div className="preview-model-head-line">
      {props.offers.some((offer) => !offer.free && offer.offerId) && (
        <Button
          disabled={
            !props.target?.offerId || props.target.free || props.expired
          }
          onClick={() => props.review(props.target?.offerId)}
        >
          Check payment channel
        </Button>
      )}
      <span className="ui-help-text">
        {props.offers.length} offers · advertised input / output per million
        tokens
      </span>
      <Button
        variant={BUTTON_VARIANT.PRIMARY}
        disabled={props.expired || (!props.choice && !props.auto)}
        onClick={() => {
          if (props.choice) props.choose(props.choice.id);
          else props.auto?.();
        }}
      >
        Use this model
      </Button>
    </div>
  );
}

function StrategyControls({
  manual,
  expired,
  choice,
  strategy,
  automaticAvailable,
  change,
}: {
  manual?: ModelOption;
  expired: boolean;
  choice?: ModelOption;
  strategy: 'Auto' | 'Cheapest';
  automaticAvailable: boolean;
  change(value: 'Auto' | 'Cheapest'): void;
}) {
  return (
    <>
      {' '}
      <div
        className="preview-strategy"
        role="group"
        aria-label="Seller selection"
      >
        <Button
          aria-pressed={!manual && strategy === 'Auto'}
          disabled={!automaticAvailable}
          onClick={() => {
            change('Auto');
          }}
        >
          Auto
        </Button>
        <Button
          aria-pressed={!manual && strategy === 'Cheapest'}
          onClick={() => {
            change('Cheapest');
          }}
        >
          Cheapest
        </Button>
        <Button disabled>
          Fastest <Tag>Unavailable</Tag>
        </Button>
        <Button disabled>
          Most reliable <Tag>Unavailable</Tag>
        </Button>
      </div>
      <div
        className="preview-route"
        data-tone={manual ? TONE.INFO : TONE.NEUTRAL}
      >
        <span className="ui-icon-tile" aria-hidden="true">
          {manual ? <PushPin size={16} /> : <Shuffle size={16} />}
        </span>
        <span className="preview-route-copy">
          <strong>
            {manual
              ? 'Selected offer'
              : strategy === 'Auto'
                ? 'Gyblos picks the seller'
                : 'Lowest combined input and output rate'}
          </strong>
          <small>
            {expired
              ? 'This offer is no longer available. Choose another seller or strategy.'
              : (choice?.family ?? 'Use the buyer’s automatic route.')}
          </small>
        </span>
      </div>
    </>
  );
}

function matchingOffers(
  offers: readonly ModelOption[],
  name: string,
  sort: 'Seller' | 'Price',
  query: string,
) {
  const bySeller = (left: ModelOption, right: ModelOption) =>
    (left.family ?? name).localeCompare(right.family ?? name);
  return offers
    .filter((o) =>
      (o.family ?? name).toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((left, right) =>
      sort === 'Seller'
        ? bySeller(left, right)
        : left.input + left.output - right.input - right.output ||
          bySeller(left, right),
    );
}
