import { CaretRight, Check } from '@phosphor-icons/react';
import { useState, type ComponentProps } from 'react';

import { useCatalogFilters } from './catalog-filters';
import { CatalogSellerDialog } from './CatalogSellerDialog';
import { ChoiceMenu } from './Management';
import { groupPrice } from './model-price';
import type { CatalogModel } from './model-types';
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
                {rows.reduce((count, row) => count + row.providers, 0)} offers
              </span>
              <span className="preview-model-mode">
                {selected ? (automatic ? 'Auto' : 'Selected') : '—'}
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
        <small className="ui-help-text">{groups.size} models</small>
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
