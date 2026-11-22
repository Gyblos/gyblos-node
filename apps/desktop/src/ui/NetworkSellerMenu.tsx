import { CaretDown, CaretRight, Check } from '@phosphor-icons/react';
import { useState } from 'react';

import { networkModelGroups } from './announced-models';
import { priceRange } from './model-price';
import type { ModelOption } from './model-types';
import { ModelImage } from './ModelImage';
import { MenuItem } from './UI';

export function NetworkSellerMenu({
  models,
  selected,
  automatic,
  buyerModel,
  paid,
  onAuto,
  onSelect,
}: {
  models: readonly ModelOption[];
  selected: string;
  automatic: boolean;
  buyerModel: string;
  paid: boolean;
  onAuto(): void;
  onSelect(id: string): void;
}) {
  const [expanded, setExpanded] = useState<string>();
  return [...networkModelGroups(models)].map(([name, offers]) => (
    <div key={name}>
      <MenuItem
        label={name}
        detail={offers.length === 1 ? '1 offer' : offers.length + ' offers'}
        aria-expanded={expanded === name}
        leading={<ModelImage artwork={offers[0]!.image} name={name} />}
        trailing={expanded === name ? <CaretDown /> : <CaretRight />}
        onClick={() => setExpanded(expanded === name ? undefined : name)}
      />
      {expanded === name && (
        <div role="group" aria-label={'Seller for ' + name}>
          {name === buyerModel && (
            <MenuItem
              role="menuitemradio"
              label="Auto"
              detail={
                paid
                  ? 'Choose a seller within your limits'
                  : 'Free offers only · Enable paid offers in Payments'
              }
              checked={automatic}
              trailing={automatic && <Check />}
              onClick={onAuto}
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
