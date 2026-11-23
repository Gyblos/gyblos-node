import { CaretRight, Check } from '@phosphor-icons/react';
import { useState, type ComponentProps } from 'react';

import { useCatalogFilters } from './catalog-filters';
import { ChoiceMenu } from './Management';
import { moveMenuFocus } from './menu-keyboard';
import { Modal } from './Modal';
import { groupPrice } from './model-price';
import type { CatalogModel } from './model-types';
import { ModelImage } from './ModelImage';
import { MotionPresence } from './Motion';
import { NetworkSellerMenu } from './NetworkSellerMenu';

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
      <div className="ui-toolbar">
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
        <small>{groups.size} models</small>
      </div>
      {!groups.size && (
        <p className="ui-help-text" role="status">
          No offers match these filters.
        </p>
      )}
      {options.ordered.map(([model, rows]) => {
        const first = rows[0];
        if (!first) return null;
        const selected =
          rows.some((row) => row.id === props.selected) ||
          (props.automatic && props.selected === 'auto/' + model);
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
              onClick={() => setName(model)}
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
                  · {[...new Set(rows.map((row) => row.context))].join(', ')}{' '}
                  context
                </small>
              </span>
              <span className="preview-model-stats">
                {rows.reduce((count, row) => count + row.providers, 0)} offers
              </span>
              <span className="ui-price">{groupPrice(rows)}</span>
              <CaretRight size={14} />
            </button>
          </div>
        );
      })}
      <MotionPresence>
        {name && offers && (
          <Modal title={name} size="lg" close={() => setName(undefined)}>
            <div className="preview-seller-drawer">
              <h3>Choose a seller</h3>
              <div
                role="menu"
                aria-label="Seller options"
                onKeyDown={moveMenuFocus}
              >
                <NetworkSellerMenu
                  {...props}
                  models={offers}
                  initiallyExpanded={name}
                  onSelect={pick}
                  onAuto={(model) => {
                    setName(undefined);
                    props.onAuto(model);
                  }}
                />
              </div>
            </div>
          </Modal>
        )}
      </MotionPresence>
    </>
  );
}
