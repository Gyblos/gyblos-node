// Quick model selection for chat; the full catalog remains a separate screen.
import { CaretDown, Check } from '@phosphor-icons/react';

import { MENU_GEOMETRY, MODEL_SOURCE } from './constants';
import { Dropdown } from './Dropdown';
import type { ModelOption } from './model-types';
import { ModelImage } from './ModelImage';
import { Badge, MenuItem } from './UI';

export type { ModelOption } from './model-types';

function priceLabel(model: ModelOption) {
  return model.free
    ? 'Free'
    : `$${model.input.toFixed(2)} in · $${model.output.toFixed(2)} out / 1M tokens`;
}

function modelDetail(model: ModelOption) {
  if (model.source === MODEL_SOURCE.ANNOUNCED)
    return `${model.family ?? 'Signed announcement'} · Announced · Chat preview`;
  return model.free ? 'Preview model' : priceLabel(model);
}

export function ModelDropdown({
  model,
  models,
  onSelect,
  onBrowse,
  toolbar = false,
  label,
  showBrowse = true,
}: {
  model: ModelOption;
  models: readonly ModelOption[];
  onSelect: (id: string) => void;
  onBrowse: () => void;
  toolbar?: boolean;
  label?: string;
  showBrowse?: boolean;
}) {
  const ordered = [model, ...models.filter((item) => item.id !== model.id)];
  return (
    <Dropdown
      searchLabel="Search models"
      label={label ?? (toolbar ? 'Choose chat model' : 'Choose composer model')}
      className={toolbar ? 'model-picker' : 'composer-model'}
      trigger={
        <>
          <ModelImage artwork={model.image} name={model.name} />
          {model.name}
          {model.free ? (
            <Badge>Free</Badge>
          ) : (
            <span className="model-trigger-price" title={priceLabel(model)}>
              ${model.input.toFixed(2)} / ${model.output.toFixed(2)} /M
            </span>
          )}
          <CaretDown size={12} />
        </>
      }
    >
      {(close, query) => {
        const filtered = ordered.filter((item) =>
          `${item.name} ${item.family ?? ''}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        );
        const options = query.trim()
          ? filtered
          : filtered.slice(0, MENU_GEOMETRY.QUICK_MODELS);
        return (
          <>
            {options.map((item) => (
              <MenuItem
                key={item.id}
                role="menuitemradio"
                checked={item.id === model.id}
                label={item.name}
                detail={modelDetail(item)}
                badge={item.free ? <Badge>Free</Badge> : undefined}
                leading={<ModelImage artwork={item.image} name={item.name} />}
                trailing={item.id === model.id && <Check size={16} />}
                onClick={() => {
                  close();
                  onSelect(item.id);
                }}
              />
            ))}
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
      }}
    </Dropdown>
  );
}
