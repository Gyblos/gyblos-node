// Uses the approved compact catalog layout with the existing selection and network policies.
import { useState } from 'react';

import { matchesCatalog, type ModelFilter } from './catalog-state';
import { MODEL_FILTER, MODELS } from './constants';
import { ChoiceMenu } from './Management';
import { Modal } from './Modal';
import type { CatalogModel } from './model-types';
import { ModelImage } from './ModelImage';
import { NetworkCatalogPanel, useNetworkCatalog } from './NetworkCatalog';
import {
  Badge,
  Button,
  List,
  ListRow,
  PagePanel,
  RowCopy,
  SearchField,
} from './UI';

export function Models({
  selected,
  canSelect,
  onSelect,
  catalog,
}: {
  selected: string;
  canSelect: boolean;
  onSelect(model: CatalogModel): void;
  catalog: ReturnType<typeof useNetworkCatalog>;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ModelFilter>(MODEL_FILTER.ALL);
  const [network, setNetwork] = useState(false);
  return (
    <PagePanel>
      <div className="ui-toolbar">
        <SearchField
          label="Search catalog"
          placeholder="Search models"
          value={query}
          onValueChange={setQuery}
        />
        <ChoiceMenu
          label="Model filter"
          value={filter}
          options={Object.values(MODEL_FILTER)}
          onChange={(value) => {
            const next = Object.values(MODEL_FILTER).find(
              (option) => option === value,
            );
            if (next) setFilter(next);
          }}
        />
        <Button onClick={() => setNetwork(true)}>Check network</Button>
        <Badge>Preview</Badge>
      </div>
      <List label="Model catalog">
        {MODELS.filter((model) => matchesCatalog(model, query, filter)).map(
          (model) => (
            <ModelRow
              key={model.id}
              model={model}
              selected={selected}
              canSelect={canSelect}
              onSelect={onSelect}
            />
          ),
        )}
        {!MODELS.some((model) => matchesCatalog(model, query, filter)) && (
          <p className="ui-list-empty">No models match your search.</p>
        )}
      </List>
      {!canSelect && (
        <p className="ui-help-text">
          PayPal uses its configured local model. This catalog is a USDC
          preview.
        </p>
      )}
      {network && (
        <Modal title="Check network" close={() => setNetwork(false)}>
          <div className="ui-section">
            <NetworkCatalogPanel
              snapshot={catalog.snapshot}
              onLookup={catalog.lookup}
              selected={selected}
            />
          </div>
        </Modal>
      )}
    </PagePanel>
  );
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
          <strong>
            {model.free
              ? 'Free'
              : '$' + model.input.toFixed(2) + ' / $' + model.output.toFixed(2)}
          </strong>
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
