// Quick model selection for chat; the full catalog remains a separate screen.
import { Check } from '@phosphor-icons/react';

import { MENU_GEOMETRY, MODEL_SOURCE } from './constants';
import { Dropdown } from './Dropdown';
import { priceRange, usdPerMtok } from './model-price';
import type { ModelOption } from './model-types';
import { ModelImage } from './ModelImage';
import { NetworkSellerMenu } from './NetworkSellerMenu';
import { Badge, MenuItem } from './UI';

export type { ModelOption } from './model-types';

function priceLabel(model: ModelOption) {
  return model.free
    ? 'Free'
    : `${usdPerMtok(model.input)} in · ${usdPerMtok(model.output)} out / 1M tokens`;
}

function modelDetail(model: ModelOption) {
  if (model.source === MODEL_SOURCE.ANNOUNCED)
    return `${model.family ?? 'Signed announcement'} · ${model.free ? 'Free' : priceLabel(model)}`;
  return model.free ? 'Preview model' : priceLabel(model);
}

type PickerProps = {
  model: ModelOption;
  models: readonly ModelOption[];
  onSelect: (id: string) => void;
  onBrowse: () => void;
  toolbar?: boolean;
  label?: string;
  showBrowse?: boolean;
  networkOnly?: boolean;
  contextLabel?: string;
  auto?: {
    buyerModels: readonly string[];
    paid: boolean;
    choose(name: string): void;
  };
};
export function ModelDropdown({
  model,
  models,
  onSelect,
  onBrowse,
  toolbar = false,
  label,
  showBrowse = true,
  networkOnly = false,
  contextLabel,
  auto,
}: PickerProps) {
  const network =
    networkOnly ||
    models.some((item) => item.source === MODEL_SOURCE.ANNOUNCED);
  const ordered = network
    ? models
    : [model, ...models.filter((item) => item.id !== model.id)];
  return (
    <Dropdown
      panelClassName="preview-model-menu"
      searchLabel="Search models"
      label={label ?? (toolbar ? 'Choose chat model' : 'Choose composer model')}
      className={toolbar ? 'model-picker' : 'ui-model-trigger'}
      trigger={
        <>
          <ModelImage artwork={model.image} name={model.name} />
          {model.name}
          {model.automatic ? (
            <Badge>Auto</Badge>
          ) : contextLabel ? (
            <Badge>Local</Badge>
          ) : network &&
            !models.some((item) => item.id === model.id) ? null : model.free ? (
            <Badge>Free</Badge>
          ) : (
            <span className="model-trigger-price" title={priceLabel(model)}>
              {priceRange(model)} /M
            </span>
          )}
        </>
      }
    >
      {(close, query) => {
        return (
          <ModelOptions
            {...{
              close,
              query,
              ordered,
              network,
              model,
              auto,
              onSelect,
              onBrowse,
              contextLabel,
              showBrowse,
            }}
          />
        );
      }}
    </Dropdown>
  );
}

function ModelOptions({
  close,
  query,
  ordered,
  network,
  model,
  auto,
  onSelect,
  onBrowse,
  contextLabel,
  showBrowse,
}: Pick<
  PickerProps,
  'model' | 'auto' | 'onSelect' | 'onBrowse' | 'contextLabel' | 'showBrowse'
> & {
  close(): void;
  query: string;
  ordered: readonly ModelOption[];
  network: boolean;
}) {
  const options = matchingModels(ordered, query, network);
  return (
    <>
      {auto ? (
        <NetworkSellerMenu
          models={options}
          selected={model.id}
          automatic={!!model.automatic}
          buyerModels={auto.buyerModels}
          paid={auto.paid}
          onAuto={(name) => {
            close();
            auto.choose(name);
          }}
          onSelect={(id) => {
            close();
            onSelect(id);
          }}
        />
      ) : (
        options.map((item) => (
          <MenuItem
            key={item.id}
            role="menuitemradio"
            checked={item.id === model.id}
            label={item.name}
            detail={contextLabel ?? modelDetail(item)}
            badge={item.free ? <Badge>Free</Badge> : undefined}
            leading={<ModelImage artwork={item.image} name={item.name} />}
            trailing={item.id === model.id && <Check size={16} />}
            onClick={() => {
              close();
              onSelect(item.id);
            }}
          />
        ))
      )}
      {!options.length && (
        <p className="dropdown-note" role="status">
          No models found
        </p>
      )}
      {showBrowse && (
        <MenuItem
          footer
          label="View all models"
          onClick={() => {
            close();
            onBrowse();
          }}
        />
      )}
    </>
  );
}

function matchingModels(
  ordered: readonly ModelOption[],
  query: string,
  network: boolean,
): readonly ModelOption[] {
  const filtered = ordered.filter((item) =>
    `${item.name} ${item.family ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return network || query.trim()
    ? filtered
    : filtered.slice(0, MENU_GEOMETRY.QUICK_MODELS);
}
