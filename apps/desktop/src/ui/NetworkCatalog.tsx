// Shares compact catalog controls and rows; network data never enables real inference.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CATALOG_STATE,
  emptyCatalog,
  NETWORK_CATALOG,
  parseNetworkCatalog,
  validCatalogQuery,
  type NetworkCatalog,
} from '../catalog/model';
import { announcedModels } from './announced-models';
import { priceRange } from './model-price';
import type { CatalogModel } from './model-types';
import { ModelImage } from './ModelImage';
import { Badge, List, ListRow, RowCopy, SearchField } from './UI';

declare global {
  interface Window {
    desktopCatalog?: {
      summary(): Promise<NetworkCatalog>;
      lookup(model: string): Promise<NetworkCatalog>;
      lookupAuto(model: string): Promise<NetworkCatalog>;
    };
  }
}
export function useNetworkCatalog() {
  const [snapshot, setSnapshot] = useState(emptyCatalog);
  const [searchResult, setSearchResult] = useState<NetworkCatalog | null>(null);
  const active = useRef(false);
  const sequence = useRef(0);
  const read = useCallback(async (query?: string) => {
    const current = query === undefined ? undefined : ++sequence.current;
    if (query !== undefined)
      setSearchResult(emptyCatalog(CATALOG_STATE.LOADING, query));
    let next = emptyCatalog(CATALOG_STATE.ERROR, query);
    try {
      next = parseNetworkCatalog(
        await (query === undefined
          ? window.desktopCatalog?.summary()
          : window.desktopCatalog?.lookup(query)),
        query,
      );
    } catch {
      /* No raw network/native diagnostics belong in the renderer. */
    }
    if (!active.current) return;
    if (current !== undefined) {
      if (current === sequence.current) setSearchResult(next);
    } else
      setSnapshot((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
  }, []);
  useEffect(() => {
    active.current = true;
    void read();
    const timer = window.setInterval(() => {
      void read();
    }, NETWORK_CATALOG.POLL_MS);
    return () => {
      active.current = false;
      window.clearInterval(timer);
    };
  }, [read]);
  return {
    async autoListings(
      name: string,
      offers: ReturnType<typeof announcedModels>,
    ) {
      const partial =
        snapshot.truncated ||
        (searchResult?.query === name && searchResult.truncated);
      if (!partial) return { offers, partial: false };
      const latest = parseNetworkCatalog(
        await window.desktopCatalog?.lookupAuto(name).catch(() => null),
        name,
      );
      if (
        latest.state === CATALOG_STATE.READY ||
        latest.state === CATALOG_STATE.EMPTY
      )
        return {
          offers: announcedModels(latest, Date.now()),
          partial: latest.truncated,
        };
      return { offers, partial: true };
    },
    snapshot,
    searchResult: searchResult ?? snapshot,
    lookup: (query: string) => {
      void read(query);
    },
  };
}
function useCatalogSearch(
  snapshot: NetworkCatalog,
  onLookup: (query: string) => void,
) {
  const [query, setQuery] = useState(snapshot.query);
  const [knownIds, setKnownIds] = useState<string[]>([]);
  useEffect(() => {
    const ids = announcedModels(snapshot, Date.now()).map(
      (model) => model.name,
    );
    if (ids.length)
      setKnownIds((previous) => [...new Set([...previous, ...ids])]);
  }, [snapshot]);
  const [editing, setEditing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const matching = knownIds
    .filter((id) => id.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, NETWORK_CATALOG.MAX_SUGGESTIONS);
  const expanded = editing && matching.length > 0;
  const submit = (id: string) => {
    setQuery(id);
    setEditing(false);
    setActiveIndex(-1);
    onLookup(id);
  };
  const loading = snapshot.state === CATALOG_STATE.LOADING;
  const valid = validCatalogQuery(query.trim()) && !loading;
  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      setActiveIndex(-1);
    }
    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      matching.length
    ) {
      event.preventDefault();
      setEditing(true);
      setActiveIndex((index) =>
        event.key === 'ArrowDown'
          ? (index + 1) % matching.length
          : index <= 0
            ? matching.length - 1
            : index - 1,
      );
    }
    if (event.key === 'Enter' && expanded && activeIndex >= 0 && !loading) {
      event.preventDefault();
      submit(matching[activeIndex]!);
    }
  }
  return {
    query,
    valid,
    expanded,
    submit,
    activeIndex,
    matching,
    loading,
    setQuery,
    setEditing,
    setActiveIndex,
    keyDown,
  };
}
function CatalogSearch({
  search,
}: {
  search: ReturnType<typeof useCatalogSearch>;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (search.valid) search.submit(search.query.trim());
      }}
    >
      <label htmlFor="preview-network-model">Model ID</label>
      <div className="network-model-picker">
        <SearchField
          label="Model ID"
          id="preview-network-model"
          role="combobox"
          value={search.query}
          placeholder="Search by model ID"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={search.expanded}
          aria-controls={search.expanded ? 'preview-model-options' : undefined}
          aria-activedescendant={
            search.expanded && search.activeIndex >= 0
              ? 'preview-model-option-' + search.activeIndex
              : undefined
          }
          onFocus={() => search.setEditing(true)}
          onBlur={() => search.setEditing(false)}
          onValueChange={(value) => {
            search.setQuery(value);
            search.setEditing(true);
            search.setActiveIndex(-1);
          }}
          onKeyDown={search.keyDown}
        />
        {search.expanded && (
          <ul
            role="listbox"
            aria-label="Matching model IDs"
            id="preview-model-options"
          >
            {search.matching.map((id, index) => (
              <li
                key={id}
                id={'preview-model-option-' + index}
                role="option"
                aria-selected={index === search.activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!search.loading) search.submit(id);
                }}
              >
                {id}
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
}
export function NetworkCatalogPanel({
  snapshot,
  onLookup,
  selected,
  onSelect,
}: {
  snapshot: NetworkCatalog;
  onLookup: (query: string) => void;
  selected: string;
  onSelect?: (model: CatalogModel) => void;
}) {
  const search = useCatalogSearch(snapshot, onLookup);
  const { query, expanded } = search;
  const models = announcedModels(snapshot, Date.now());
  const messages = {
    [CATALOG_STATE.LOADING]: 'Searching…',
    [CATALOG_STATE.IDLE]: 'Enter a model ID to search.',
    [CATALOG_STATE.EMPTY]: `No listings for “${snapshot.query}”.`,
    [CATALOG_STATE.ERROR]: 'Search unavailable. Try again.',
    [CATALOG_STATE.STALE]: 'Listings expired. Search again.',
    [CATALOG_STATE.READY]: models.length ? '' : 'No current listings.',
  };
  return (
    <div className="network-search">
      <CatalogSearch search={search} />
      {snapshot.query && query.trim() === snapshot.query && !expanded && (
        <section aria-live="polite" aria-label="Search results">
          {models.length > 0 && (
            <>
              <h3>Choose a seller</h3>
              <p>Prices in USDC per million tokens, input / output.</p>
              <List label="Network models">
                {models.map((model) => (
                  <ListRow
                    key={model.id}
                    selected={!!onSelect && selected === model.id}
                    onActivate={onSelect ? () => onSelect(model) : undefined}
                    leading={
                      <ModelImage name={model.name} artwork={model.image} />
                    }
                    trailing={
                      <Badge>{model.free ? 'Free' : priceRange(model)}</Badge>
                    }
                  >
                    <RowCopy
                      title={model.name}
                      detail={model.family + ' · ' + model.context + ' tokens'}
                    />
                  </ListRow>
                ))}
              </List>
            </>
          )}
          {messages[snapshot.state] && <p>{messages[snapshot.state]}</p>}
          {snapshot.truncated && <small>Showing partial results.</small>}
        </section>
      )}
      <small>Signed listings · Availability is checked when you send.</small>
    </div>
  );
}
