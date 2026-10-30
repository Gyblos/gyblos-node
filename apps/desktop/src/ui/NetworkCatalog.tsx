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
import { BUTTON_VARIANT } from './constants';
import type { CatalogModel } from './model-types';
import { ModelImage } from './ModelImage';
import {
  Badge,
  Button,
  List,
  ListRow,
  Note,
  RowCopy,
  SearchField,
  SectionTitle,
} from './UI';

declare global {
  interface Window {
    desktopCatalog?: {
      summary(): Promise<NetworkCatalog>;
      lookup(model: string): Promise<NetworkCatalog>;
    };
  }
}
export function useNetworkCatalog() {
  const [snapshot, setSnapshot] = useState(emptyCatalog);
  const active = useRef(false);
  const sequence = useRef(0);
  const read = useCallback(async (query?: string) => {
    const current = ++sequence.current;
    if (query !== undefined)
      setSnapshot(emptyCatalog(CATALOG_STATE.LOADING, query));
    let next = emptyCatalog(CATALOG_STATE.ERROR);
    try {
      next = parseNetworkCatalog(
        await (query === undefined
          ? window.desktopCatalog?.summary()
          : window.desktopCatalog?.lookup(query)),
      );
    } catch {
      /* No raw network/native diagnostics belong in the renderer. */
    }
    if (active.current && sequence.current === current)
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
    snapshot,
    lookup: (query: string) => {
      void read(query);
    },
  };
}
function CatalogStatus({ snapshot }: { snapshot: NetworkCatalog }) {
  const message =
    snapshot.state === CATALOG_STATE.IDLE
      ? 'Enter an exact model ID to check announcements.'
      : snapshot.state === CATALOG_STATE.LOADING
        ? 'Checking announcements…'
        : snapshot.state === CATALOG_STATE.ERROR
          ? 'Could not check announcements. Try again.'
          : snapshot.state === CATALOG_STATE.STALE
            ? 'Announcements expired. Refresh to check again.'
            : snapshot.state === CATALOG_STATE.EMPTY
              ? 'No free announcements returned for this model.'
              : 'Signed announcements · availability not checked.';
  return (
    <p className="dropdown-note" role="status">
      {message}
      {snapshot.checkedAt !== null && (
        <> · Checked {new Date(snapshot.checkedAt).toLocaleTimeString()}</>
      )}
    </p>
  );
}
function AnnouncementList({
  models,
  selected,
  onSelect,
}: {
  models: CatalogModel[];
  selected: string;
  onSelect: (model: CatalogModel) => void;
}) {
  return (
    <>
      {' '}
      {models.length > 0 && (
        <List label="Network model announcements">
          {models.map((model) => (
            <ListRow
              key={model.id}
              selected={selected === model.id}
              leading={<ModelImage name={model.name} artwork={model.image} />}
              trailing={<Badge>Free</Badge>}
              onActivate={() => onSelect(model)}
            >
              <RowCopy
                title={model.name}
                detail={`${model.family} · ${model.context} context · ${model.providers} signed announcement${model.providers === 1 ? '' : 's'} · Chat preview`}
              />
            </ListRow>
          ))}
        </List>
      )}
    </>
  );
}
export function NetworkCatalogPanel({
  snapshot,
  onLookup,
  onSelect,
  selected,
}: {
  snapshot: NetworkCatalog;
  onLookup: (query: string) => void;
  onSelect: (model: CatalogModel) => void;
  selected: string;
}) {
  const [query, setQuery] = useState(snapshot.query);
  const models = announcedModels(snapshot, Date.now());
  return (
    <>
      <SectionTitle trailing={<Badge>Read only</Badge>}>
        Network announcements
      </SectionTitle>
      <form
        className="ui-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            validCatalogQuery(query) &&
            snapshot.state !== CATALOG_STATE.LOADING
          )
            onLookup(query);
        }}
      >
        <SearchField
          label="Model ID"
          placeholder="Exact model ID, e.g. qwen3:0.6b"
          value={query}
          onValueChange={setQuery}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={
            !validCatalogQuery(query) ||
            snapshot.state === CATALOG_STATE.LOADING
          }
        >
          Check network
        </Button>
      </form>
      <CatalogStatus snapshot={snapshot} />
      {snapshot.query && (
        <p className="dropdown-note">
          Results for {snapshot.query} · free input and output
        </p>
      )}
      <AnnouncementList
        models={models}
        selected={selected}
        onSelect={onSelect}
      />
      {snapshot.truncated && (
        <Note>First page only. More announcements may exist.</Note>
      )}
      <Note>
        Search checks signed announcements for one model ID, not the whole
        network. Provider identity and availability are not verified. Chat and
        Connect remain simulated.
      </Note>
    </>
  );
}
