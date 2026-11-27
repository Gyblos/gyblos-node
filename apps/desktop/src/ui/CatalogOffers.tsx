import { CaretRight, Check } from '@phosphor-icons/react';
import { useState, type ComponentProps } from 'react';

import { RESPONSE_METRICS } from '../constants';
import { useCatalogFilters } from './catalog-filters';
import { CatalogSellerDialog } from './CatalogSellerDialog';
import { ChoiceMenu } from './Management';
import { groupPrice, usdPerMtok } from './model-price';
import type { CatalogModel, ModelOption } from './model-types';
import { ModelImage } from './ModelImage';
import { MotionPresence } from './Motion';
import type { NetworkSellerMenu } from './NetworkSellerMenu';
import { List } from './UI';

function CatalogRows({
  ordered,
  selectedId,
  automatic,
  open,
}: {
  ordered: ReturnType<typeof useCatalogFilters>['ordered'];
  selectedId: string;
  automatic: boolean;
  open(name: string): void;
}) {
  return (
    <>
      {' '}
      {ordered.map(([model, rows]) => {
        const first = rows[0];
        if (!first) return null;
        const selected =
          rows.some((row) => row.id === selectedId) ||
          (automatic && selectedId === 'auto/' + model);
        return (
          <div
            key={model}
            className="preview-model-item"
            data-current={selected}
          >
            <button
              type="button"
              className="preview-model-head preview-model-summary"
              aria-haspopup="dialog"
              onClick={() => open(model)}
            >
              <ModelImage name={model} artwork={first.image} />
              <span className="preview-model-copy">
                <strong>
                  {model}
                  {selected && <Check size={14} aria-label="In use" />}
                </strong>
                <small>
                  {[
                    ...new Set(rows.map((row) => row.variant).filter(Boolean)),
                  ].join(', ')}{' '}
                  {[...new Set(rows.map((row) => row.context))].join(', ')}{' '}
                  context
                </small>
              </span>
              <span className="preview-model-stats">
                <small>
                  {rows.reduce((count, row) => count + row.providers, 0)} offers
                </small>
                <InputPriceRange offers={rows} selected={selectedId} />
              </span>
              <span className="preview-model-mode">
                {selected ? (automatic ? 'Auto' : 'Selected') : ''}
              </span>
              <span className="ui-price">
                <strong>{groupPrice(rows)}</strong>
              </span>
              <CaretRight size={14} />
            </button>
          </div>
        );
      })}
    </>
  );
}
export function CatalogOffers(
  props: Omit<ComponentProps<typeof NetworkSellerMenu>, 'models'> & {
    policy?: ComponentProps<typeof CatalogSellerDialog>['policy'];
    models: readonly CatalogModel[];
  },
) {
  const [name, setName] = useState<string>();
  const options = useCatalogFilters(props.models);
  const groups = options.groups;
  const offers = name ? groups.get(name) : undefined;
  const pick = (id: string) => {
    setName(undefined);
    props.onSelect(id);
  };
  return (
    <>
      <div className="ui-toolbar preview-catalog-filters">
        <ChoiceMenu
          label="Variant"
          value={options.variant}
          options={options.variants}
          onChange={options.setVariant}
        />
        <ChoiceMenu
          label="Context"
          value={options.context}
          options={options.contexts}
          onChange={options.setContext}
        />
        <ChoiceMenu
          label="Sort models"
          value={options.sort}
          options={options.sorts}
          onChange={options.setSort}
        />
        <small className="ui-help-text">
          {groups.size === 1 ? '1 model' : groups.size + ' models'}
        </small>
      </div>
      <List label="Model catalog">
        {!groups.size && (
          <p className="ui-help-text" role="status">
            No offers match these filters.
          </p>
        )}
        <CatalogRows
          ordered={options.ordered}
          selectedId={props.selected}
          automatic={props.automatic}
          open={setName}
        />
      </List>
      <MotionPresence>
        {name && offers && (
          <CatalogSellerDialog
            key={name}
            name={name}
            policy={props.policy}
            offers={offers}
            selected={props.selected}
            automatic={props.automatic}
            choose={pick}
            close={() => setName(undefined)}
            auto={
              props.buyerModels.includes(name)
                ? () => {
                    setName(undefined);
                    props.onAuto(name);
                  }
                : undefined
            }
          />
        )}
      </MotionPresence>
    </>
  );
}

function InputPriceRange({
  offers,
  selected,
}: {
  offers: readonly ModelOption[];
  selected: string;
}) {
  if (!offers.some((offer) => !offer.free)) return null;
  const prices = offers.map((offer) => offer.input);
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const active = offers.find((offer) => offer.id === selected);
  const position =
    active && maximum > minimum
      ? (RESPONSE_METRICS.PERCENT_SCALE * (active.input - minimum)) /
        (maximum - minimum)
      : 0;
  return (
    <span
      className="preview-price-range"
      aria-label={
        'Input price from ' + usdPerMtok(minimum) + ' to ' + usdPerMtok(maximum)
      }
    >
      <span>{usdPerMtok(minimum)}</span>
      <span className="preview-price-track">
        {active && <span style={{ left: position + '%' }} />}
      </span>
      <span>{usdPerMtok(maximum)}</span>
    </span>
  );
}
