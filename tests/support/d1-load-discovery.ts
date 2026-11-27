import {
  NETWORK_HISTORY,
  OFFER_HISTORY,
} from '@gyblos/discovery-index/constants';
import { rollupNetworkDays } from '@gyblos/discovery-index/network-history';
import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';

import { D1_LOAD_LABELS, measureD1Step, type D1LoadRow } from './d1-load-log';
import { indexHarness, indexNode, MODEL } from './discovery-index-fixture';

const CREATED = 201;
const OK = 200;

async function expectStatus(response: Response, status: number) {
  if (response.status !== status)
    throw new Error(`unexpected status ${response.status}`);
  await response.arrayBuffer();
}

export async function discoveryLoad(): Promise<D1LoadRow[] | null> {
  const harness = await indexHarness('sqlite-d1');
  const database = harness?.database;
  if (!harness || !database) return null;
  await expectStatus(await harness.publish(indexNode().catalog(1)), CREATED);
  const narrow = indexNode();
  const wide = indexNode();
  const models = Array.from(
    { length: PUBLIC_RECORD_LIMITS.maxModels },
    (_, index) => `${MODEL}-${index}`,
  );
  const read = (path: string) => async () =>
    expectStatus(await harness.call(path), OK);
  const step = (label: D1LoadRow['label'], action: () => Promise<unknown>) =>
    measureD1Step(label, database, action);
  return [
    await step(D1_LOAD_LABELS.PUBLISH_CATALOG_1, async () =>
      expectStatus(await harness.publish(narrow.catalog(1)), CREATED),
    ),
    await step(D1_LOAD_LABELS.PUBLISH_CATALOG_64, async () =>
      expectStatus(await harness.publish(wide.catalog(1, { models })), CREATED),
    ),
    await step(D1_LOAD_LABELS.READ_NETWORK, read('/v1/network')),
    await step(D1_LOAD_LABELS.READ_MODELS, read('/v1/models')),
    await step(
      D1_LOAD_LABELS.READ_OFFER_HISTORY,
      read(
        `/v1/offers/history?node=${wide.nodeId}&days=${OFFER_HISTORY.maxDays}`,
      ),
    ),
    await step(
      D1_LOAD_LABELS.READ_NETWORK_HISTORY,
      read(`/v1/network/history?days=${NETWORK_HISTORY.maxDays}`),
    ),
    await step(D1_LOAD_LABELS.CRON_ROLLUP, () =>
      rollupNetworkDays(harness.storage, harness.clock.now),
    ),
  ];
}
