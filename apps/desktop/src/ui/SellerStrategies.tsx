import {
  CurrencyCircleDollar,
  Lightning,
  ShieldCheck,
  Sparkle,
  type Icon,
} from '@phosphor-icons/react';

import { Modal } from './Modal';
import { priceRange } from './model-price';
import type { ModelOption } from './model-types';
import { ModelMenuTrail } from './ModelMenuBadges';
import { Tag } from './Tag';
import { Button, MenuItem } from './UI';

function Strategy({
  icon: Icon,
  label,
  detail,
  price,
  checked = false,
  choose,
}: {
  icon: Icon;
  label: string;
  detail: string;
  price?: string;
  checked?: boolean;
  choose?: () => void;
}) {
  return (
    <MenuItem
      data-strategy
      role="menuitemradio"
      label={label}
      detail={detail}
      disabled={!choose}
      checked={checked}
      leading={
        <span className="preview-strategy-icon">
          <Icon size={16} />
        </span>
      }
      badge={
        price ? (
          <span className="preview-offer-price">{price}</span>
        ) : (
          !choose && <Tag>Unavailable</Tag>
        )
      }
      trailing={<ModelMenuTrail selected={checked} multiple={false} />}
      onClick={choose}
    />
  );
}
export function SellerStrategies({
  name,
  offers,
  auto,
  selected,
  choose,
  compare,
}: {
  name: string;
  offers: readonly ModelOption[];
  auto?: () => void;
  selected: string;
  choose: (id: string) => void;
  compare: () => void;
}) {
  const lowest = offers.reduce((best, item) =>
    (item.free && !best.free) ||
    (item.free === best.free &&
      item.input + item.output < best.input + best.output)
      ? item
      : best,
  );
  return (
    <>
      <Strategy
        icon={Sparkle}
        label="Auto"
        detail={
          auto
            ? 'Use the buyer’s automatic route'
            : 'No automatic route for this model'
        }
        checked={selected === 'auto/' + name}
        choose={auto}
      />
      <Strategy
        icon={CurrencyCircleDollar}
        label="Cheapest"
        detail={
          lowest.free ? 'Free offer' : 'Lowest combined input and output rate'
        }
        price={lowest.free ? 'Free' : priceRange(lowest)}
        checked={selected === lowest.id}
        choose={() => choose(lowest.id)}
      />
      <Strategy icon={Lightning} label="Fastest" detail="No measured latency" />
      <Strategy
        icon={ShieldCheck}
        label="Most reliable"
        detail="No measured reliability"
      />
      <MenuItem
        footer
        label={'Compare ' + offers.length + ' offers'}
        onClick={compare}
      />
    </>
  );
}
export function OfferComparison({
  name,
  offers,
  selected,
  close,
  choose,
}: {
  name: string;
  offers: readonly ModelOption[];
  selected: string;
  close(): void;
  choose(id: string): void;
}) {
  return (
    <Modal title={name} size="lg" close={close}>
      <p className="ui-help-text">
        Advertised input and output prices per million tokens.
      </p>
      <div className="preview-simple-table-region">
        <table className="preview-simple-table">
          <caption className="sr-only">Offers for {name}</caption>
          <thead>
            <tr>
              <th scope="col">Seller / variant</th>
              <th scope="col" className="preview-num">
                In / out
              </th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {offers.map((offer) => (
              <tr key={offer.id}>
                <th scope="row">{offer.family || name}</th>
                <td className="preview-num preview-tabular">
                  {offer.free ? 'Free' : priceRange(offer)}
                </td>
                <td className="preview-num">
                  <Button onClick={() => choose(offer.id)}>
                    {selected === offer.id ? 'In use' : 'Choose offer'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!offers.length && <p role="status">No matching offers remain.</p>}
    </Modal>
  );
}
