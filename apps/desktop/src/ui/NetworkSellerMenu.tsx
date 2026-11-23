import { CaretDown, CaretRight, Check } from '@phosphor-icons/react';
import { useState } from 'react';

import { MODEL_IDS } from '@gyblos/protocol/constants';

import { networkModelGroups } from './announced-models';
import { groupPrice, priceRange } from './model-price';
import type { ModelOption } from './model-types';
import { ModelImage } from './ModelImage';
import { SellerChoices } from './SellerChoices';
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
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            setExpanded(name);
          }
        }}
        aria-haspopup={offers.length > 1 ? 'menu' : undefined}
        aria-expanded={offers.length > 1 ? expanded === name : undefined}
        leading={<ModelImage artwork={offers[0]!.image} name={name} />}
        trailing={expanded === name ? <CaretDown /> : <CaretRight />}
        onClick={() => {
          if (!initiallyExpanded && offers.length === 1) {
            onSelect(offers[0]!.id);
            return;
          }
          setExpanded(expanded === name ? undefined : name);
        }}
      />
      {expanded === name && (
        <SellerChoices
          name={name}
          flyout={!initiallyExpanded}
          onDismiss={() => setExpanded(undefined)}
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
        </SellerChoices>
      )}
    </div>
  ));
}
