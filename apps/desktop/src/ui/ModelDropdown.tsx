// Quick model selection for chat; the full catalog remains a separate screen.
import { CaretDown, Check, Plus } from '@phosphor-icons/react';
import { useState } from 'react';

import type { BuyerFunding } from '../funding/model';
import { AddBuyerFunds } from './BuyerFunding';
import { MENU_GEOMETRY, MODEL_SOURCE } from './constants';
import { Dropdown } from './Dropdown';
import { Modal } from './Modal';
import { priceRange, usdPerMtok } from './model-price';
import type { ModelOption } from './model-types';
import { ModelImage } from './ModelImage';
import { NetworkSellerMenu } from './NetworkSellerMenu';
import { OfferComparison } from './SellerStrategies';
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
  funding?: BuyerFunding | null;
  refreshFunding?(): void;
  auto?: {
    buyerModels: readonly string[];
    paid: boolean;
    choose(name: string): void;
  };
};
export function ModelDropdown(props: PickerProps) {
  const { model, models, funding } = props;
  const [comparison, setComparison] = useState<string>();
  const [addingFunds, setAddingFunds] = useState(false);
  const network =
    props.networkOnly ||
    models.some((item) => item.source === MODEL_SOURCE.ANNOUNCED);
  const ordered = network
    ? models
    : [model, ...models.filter((item) => item.id !== model.id)];
  return (
    <>
      {comparison && (
        <OfferComparison
          name={comparison}
          offers={models.filter((item) => item.name === comparison)}
          selected={model.id}
          close={() => setComparison(undefined)}
          choose={(id) => {
            setComparison(undefined);
            props.onSelect(id);
          }}
        />
      )}
      {addingFunds && (
        <Modal
          title="Add funds · Testnet"
          description="Your draft stays in the chat."
          close={() => setAddingFunds(false)}
        >
          <AddBuyerFunds payer={funding?.payer} />
        </Modal>
      )}
      <Dropdown
        panelClassName="preview-model-menu"
        onOpen={props.refreshFunding}
        searchLabel="Search models"
        label={
          props.label ??
          (props.toolbar ? 'Choose chat model' : 'Choose composer model') +
            ': ' +
            model.name
        }
        className={props.toolbar ? 'model-picker' : 'ui-model-trigger'}
        trigger={<PickerTrigger {...props} network={network} />}
      >
        {(close, query) => (
          <ModelOptions
            onCompare={setComparison}
            onAddFunds={() => setAddingFunds(true)}
            {...props}
            showBrowse={props.showBrowse ?? true}
            close={close}
            query={query}
            ordered={ordered}
            network={network}
          />
        )}
      </Dropdown>
    </>
  );
}

type ModelOptionsProps = Pick<
  PickerProps,
  | 'model'
  | 'auto'
  | 'onSelect'
  | 'onBrowse'
  | 'contextLabel'
  | 'showBrowse'
  | 'networkOnly'
> & {
  close(): void;
  onCompare(name: string): void;
  onAddFunds(): void;
  query: string;
  ordered: readonly ModelOption[];
  network: boolean;
};
function ModelOptions({
  close,
  query,
  ordered,
  onCompare,
  onAddFunds,
  network,
  model,
  auto,
  onSelect,
  onBrowse,
  contextLabel,
  showBrowse,
  networkOnly,
}: ModelOptionsProps) {
  const options = matchingModels(ordered, query, network);
  return (
    <>
      {network && !contextLabel ? (
        <NetworkSellerMenu
          models={options}
          onCompare={(name) => {
            close();
            onCompare(name);
          }}
          selected={model.id}
          automatic={!!model.automatic}
          buyerModels={auto?.buyerModels ?? []}
          paid={!!auto?.paid}
          onAuto={(name) => {
            close();
            auto?.choose(name);
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
      <ModelMenuActions
        close={close}
        onAddFunds={onAddFunds}
        onBrowse={onBrowse}
        contextLabel={contextLabel}
        showBrowse={showBrowse}
        networkOnly={networkOnly}
      />
    </>
  );
}

type ModelMenuActionsProps = Pick<
  ModelOptionsProps,
  | 'close'
  | 'onAddFunds'
  | 'onBrowse'
  | 'contextLabel'
  | 'showBrowse'
  | 'networkOnly'
>;
function ModelMenuActions({
  close,
  onAddFunds,
  onBrowse,
  contextLabel,
  showBrowse,
  networkOnly,
}: ModelMenuActionsProps) {
  const funds = networkOnly && !contextLabel;
  if (!showBrowse && !funds) return null;
  return (
    <div className="preview-menu-actions">
      {funds && (
        <MenuItem
          footer
          label="Add funds"
          leading={<Plus size={13} weight="bold" aria-hidden="true" />}
          onClick={() => {
            close();
            onAddFunds();
          }}
        />
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
    </div>
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

function PickerTrigger({
  model,
  models,
  network,
  contextLabel,
}: Pick<PickerProps, 'model' | 'models' | 'contextLabel'> & {
  network: boolean;
}) {
  return (
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
      <CaretDown
        size={12}
        weight="bold"
        className="preview-trigger-caret"
        aria-hidden="true"
      />
    </>
  );
}
