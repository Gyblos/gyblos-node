// Uses the approved compact catalog layout with the existing selection and network policies.
import { Globe } from '@phosphor-icons/react';
import { useState } from 'react';

import { ActionButton } from './ActionButton';
import { matchesCatalog, type ModelFilter } from './catalog-state';
import { CatalogOffers } from './CatalogOffers';
import { MODEL_FILTER, MODELS } from './constants';
import { ChoiceMenu } from './Management';
import { Modal } from './Modal';
import { priceRange } from './model-price';
import type { CatalogModel } from './model-types';
import { ModelImage } from './ModelImage';
import { NetworkCatalogPanel, useNetworkCatalog } from './NetworkCatalog';
import { Badge, List, ListRow, PagePanel, RowCopy, SearchField } from './UI';

type ModelsProps = {
  networkModels: readonly CatalogModel[];
  auto: {
    buyerModels: readonly string[];
    paid: boolean;
    selected: boolean;
    choose(name: string): void;
  } | null;
  selected: string;
  canSelect: boolean;
  onSelect(model: CatalogModel): void;
  catalog: ReturnType<typeof useNetworkCatalog>;
};
export function Models({
  selected,
  canSelect,
  onSelect,
  catalog,
  networkModels,
  auto,
}: ModelsProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ModelFilter>(MODEL_FILTER.ALL);
  const [network, setNetwork] = useState(false);
  function chooseOffer(offer: CatalogModel) {
    setNetwork(false);
    onSelect(offer);
  }
  const offers = networkModels.filter((model) =>
    matchesCatalog(model, query, filter),
  );
  return (
    <PagePanel>
      <div className="ui-toolbar">
        <SearchField
          label="Search catalog"
          placeholder="Search models"
          value={query}
          onValueChange={setQuery}
        />
        <CatalogFilter filter={filter} change={setFilter} />
        <ActionButton
          icon={<Globe size={16} />}
          label="Find network models"
          onClick={() => setNetwork(true)}
        />
        {!canSelect && <Badge>Preview</Badge>}
      </div>
      {canSelect ? (
        <CatalogOffers
          models={offers}
          selected={selected}
          automatic={!!auto?.selected}
          buyerModels={auto?.buyerModels ?? []}
          paid={!!auto?.paid}
          onAuto={(name) => auto?.choose(name)}
          onSelect={(id) => {
            const offer = offers.find((row) => row.id === id);
            if (offer) chooseOffer(offer);
          }}
        />
      ) : (
        <List label="Model catalog">
          <PreviewRows
            query={query}
            filter={filter}
            selected={selected}
            onSelect={onSelect}
          />
        </List>
      )}
      {!canSelect && (
        <p className="ui-help-text">
          PayPal uses its configured local model. This catalog is a USDC
          preview.
        </p>
      )}
      {network && (
        <Modal title="Find network models" close={() => setNetwork(false)}>
          <div className="ui-section">
            <NetworkCatalogPanel
              snapshot={catalog.searchResult}
              onLookup={catalog.lookup}
              onSelect={canSelect ? chooseOffer : undefined}
              selected={selected}
            />
          </div>
        </Modal>
      )}
    </PagePanel>
  );
}

function CatalogFilter({
  filter,
  change,
}: {
  filter: ModelFilter;
  change(value: ModelFilter): void;
}) {
  return (
    <ChoiceMenu
      label="Model filter"
      value={filter}
      options={Object.values(MODEL_FILTER)}
      onChange={(value) => {
        const next = Object.values(MODEL_FILTER).find(
          (option) => option === value,
        );
        if (next) change(next);
      }}
    />
  );
}
function PreviewRows({
  query,
  filter,
  selected,
  onSelect,
}: {
  query: string;
  filter: ModelFilter;
  selected: string;
  onSelect(model: CatalogModel): void;
}) {
  const rows = MODELS.filter((model) => matchesCatalog(model, query, filter));
  if (!rows.length)
    return <p className="ui-list-empty">No models match your search.</p>;
  return rows.map((model) => (
    <ModelRow
      key={model.id}
      model={model}
      selected={selected}
      canSelect={false}
      onSelect={onSelect}
    />
  ));
}

function ModelRow({
  model,
  selected,
  canSelect,
  onSelect,
}: {
  model: CatalogModel;
  selected: string;
  canSelect: boolean;
  onSelect(model: CatalogModel): void;
}) {
  return (
    <ListRow
      key={model.id}
      leading={<ModelImage name={model.name} artwork={model.image} />}
      selected={canSelect && selected === model.id}
      onActivate={canSelect ? () => onSelect(model) : undefined}
      trailing={
        <div className="ui-price">
          <strong>{model.free ? 'Free' : priceRange(model)}</strong>
          <small>
            {model.free ? 'Community supported' : 'In / out per 1M tokens'}
          </small>
        </div>
      }
    >
      <RowCopy
        title={model.name}
        detail={model.family + ' · ' + model.context + ' context'}
      />
    </ListRow>
  );
}
