import { Check, HardDrives, Sparkle } from '@phosphor-icons/react';
import { useState } from 'react';

import { MODEL_IDS } from '@gyblos/protocol/constants';

import { networkModelGroups } from './announced-models';
import { priceRange } from './model-price';
import type { ModelOption } from './model-types';
import { ModelImage } from './ModelImage';
import { ModelMenuBadges, ModelMenuTrail } from './ModelMenuBadges';
import { SellerChoices } from './SellerChoices';
import { SellerStrategies } from './SellerStrategies';
import { MenuItem } from './UI';

type SellerProps = {
  initiallyExpanded?: string;
  onCompare?(name: string): void;
  models: readonly ModelOption[];
  selected: string;
  automatic: boolean;
  buyerModels: readonly string[];
  paid: boolean;
  onAuto(name: string): void;
  onSelect(id: string): void;
};
export function NetworkSellerMenu(props: SellerProps) {
  const { initiallyExpanded, models, selected, automatic } = props;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return [...networkModelGroups(models)].map(([name, offers]) => (
    <div className="seller-menu-model preview-model-list" key={name}>
      <MenuItem
        label={name}
        role="menuitemradio"
        checked={
          offers.some((offer) => offer.id === selected) ||
          (automatic && selected === 'auto/' + name)
        }
        badge={<ModelMenuBadges offers={offers} />}
        data-active={expanded === name || undefined}
        data-model-row={name}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && offers.length > 1) {
            event.preventDefault();
            setExpanded(name);
          }
        }}
        aria-haspopup={offers.length > 1 ? 'menu' : undefined}
        aria-expanded={offers.length > 1 ? expanded === name : undefined}
        leading={<ModelImage artwork={offers[0]!.image} name={name} />}
        trailing={
          <ModelMenuTrail
            selected={
              offers.some((offer) => offer.id === selected) ||
              (automatic && selected === 'auto/' + name)
            }
            multiple={offers.length > 1}
          />
        }
        onClick={() => {
          if (!initiallyExpanded && offers.length === 1) {
            props.onSelect(offers[0]!.id);
            return;
          }
          setExpanded(expanded === name ? undefined : name);
        }}
      />
      {!initiallyExpanded &&
        offers.length === 1 &&
        props.buyerModels.includes(name) && (
          <MenuItem
            role="menuitemradio"
            label={'Auto · ' + name}
            detail="Use automatic seller selection"
            checked={automatic && selected === 'auto/' + name}
            onClick={() => props.onAuto(name)}
          />
        )}
      {expanded === name && (
        <SellerChoices
          name={name}
          flyout={!initiallyExpanded}
          onDismiss={() => setExpanded(undefined)}
        >
          {!initiallyExpanded && props.onCompare ? (
            <SellerStrategies
              name={name}
              offers={offers}
              selected={selected}
              choose={props.onSelect}
              auto={
                props.buyerModels.includes(name)
                  ? () => props.onAuto(name)
                  : undefined
              }
              compare={() => props.onCompare?.(name)}
            />
          ) : (
            <SellerOptions {...props} name={name} offers={offers} />
          )}
        </SellerChoices>
      )}
    </div>
  ));
}

function SellerOptions({
  name,
  offers,
  buyerModels,
  paid,
  automatic,
  selected,
  onAuto,
  onSelect,
}: Omit<SellerProps, 'models'> & {
  name: string;
  offers: readonly ModelOption[];
}) {
  return (
    <>
      {' '}
      {buyerModels.includes(name) && (
        <MenuItem
          role="menuitemradio"
          label="Auto"
          leading={
            <span className="preview-strategy-icon">
              <Sparkle size={16} />
            </span>
          }
          detail={
            paid && name === MODEL_IDS.QWEN3_0_6B
              ? 'Choose a seller within your limits'
              : name === MODEL_IDS.QWEN3_0_6B
                ? 'Free offers only · Enable paid offers in Payments'
                : 'Free offers only'
          }
          checked={automatic && selected === 'auto/' + name}
          trailing={automatic && selected === 'auto/' + name && <Check />}
          onClick={() => onAuto(name)}
        />
      )}
      {offers.map((offer) => (
        <MenuItem
          key={offer.id}
          role="menuitemradio"
          leading={
            <span className="preview-strategy-icon">
              <HardDrives size={16} />
            </span>
          }
          label={offer.family ?? name}
          detail={offer.free ? 'Free' : priceRange(offer) + ' /M tokens'}
          checked={!automatic && selected === offer.id}
          onClick={() => onSelect(offer.id)}
        />
      ))}
    </>
  );
}
