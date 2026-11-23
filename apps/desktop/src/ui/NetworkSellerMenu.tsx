import { CaretDown, CaretRight, Check } from '@phosphor-icons/react';
import { useState } from 'react';

import { MODEL_IDS } from '@gyblos/protocol/constants';

import { networkModelGroups } from './announced-models';
import { groupPrice, priceRange } from './model-price';
import type { ModelOption } from './model-types';
import { ModelImage } from './ModelImage';
import { MenuItem } from './UI';

export function NetworkSellerMenu({
  models,
  selected,
  automatic,
  buyerModels,
  paid,
  onAuto,
  onSelect,
  initiallyExpanded,
}: {
  initiallyExpanded?: string;
  models: readonly ModelOption[];
  selected: string;
  automatic: boolean;
  buyerModels: readonly string[];
  paid: boolean;
  onAuto(name: string): void;
  onSelect(id: string): void;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return [...networkModelGroups(models)].map(([name, offers]) => (
    <div className="seller-menu-model preview-model-list" key={name}>
      <MenuItem
        label={name}
        detail={
          (offers.length === 1 ? '1 offer' : offers.length + ' offers') +
          ' · ' +
          groupPrice(offers)
        }
        data-model-row={name}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight') return;
          event.preventDefault();
          const group = event.currentTarget.parentElement;
          setExpanded(name);
          requestAnimationFrame(() =>
            group
              ?.querySelector<HTMLElement>('[role="menuitemradio"]')
              ?.focus(),
          );
        }}
        aria-expanded={expanded === name}
        leading={<ModelImage artwork={offers[0]!.image} name={name} />}
        trailing={expanded === name ? <CaretDown /> : <CaretRight />}
        onClick={() => setExpanded(expanded === name ? undefined : name)}
      />
      {expanded === name && (
        <div
          className="seller-menu-choices"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft') return;
            event.preventDefault();
            event.currentTarget.parentElement
              ?.querySelector<HTMLElement>('[data-model-row]')
              ?.focus();
            setExpanded(undefined);
          }}
          role="group"
          aria-label={'Seller for ' + name}
        >
          {buyerModels.includes(name) && (
            <MenuItem
              role="menuitemradio"
              label="Auto"
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
              label={offer.family ?? name}
              detail={offer.free ? 'Free' : priceRange(offer) + ' /M tokens'}
              checked={!automatic && selected === offer.id}
              onClick={() => onSelect(offer.id)}
            />
          ))}
        </div>
      )}
    </div>
  ));
}
