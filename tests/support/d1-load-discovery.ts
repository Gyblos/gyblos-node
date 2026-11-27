import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import {
  NETWORK_HISTORY,
  OFFER_HISTORY,
} from '@gyblos/discovery-index/constants';
import { createD1GithubClaimStore } from '@gyblos/discovery-index/github-claim-store-d1';
import { createD1ModelRegistry } from '@gyblos/discovery-index/model-registry-d1';
import { rollupNetworkDays } from '@gyblos/discovery-index/network-history';
import { createD1SellerProfileStore } from '@gyblos/discovery-index/profile-store-d1';
import { createD1RegistrationStore } from '@gyblos/discovery-index/registration-store-d1';
import { inviteHash } from '@gyblos/discovery-index/registrations';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';

import { D1_LOAD_LABELS, measureD1Step, type D1LoadRow } from './d1-load-log';
import { createSqliteD1 } from './d1-sqlite';
import {
  allLimiters,
  CLIENT_IP,
  INDEX_ORIGIN,
  INDEX_OWNER,
  indexNode,
  MODEL,
  T0,
  type IndexNode,
} from './discovery-index-fixture';

const CREATED = 201;
const OK = 200;
const HOUR = 3_600_000;

async function expectStatus(response: Response, status: number) {
  if (response.status !== status)
    throw new Error(`unexpected status ${response.status}`);
  await response.arrayBuffer();
}

async function productionIndex() {
  const database = await createSqliteD1();
  if (!database) return null;
  const storage = createD1Storage(database);
  const registrations = createD1RegistrationStore(database);
  const now = T0 + 1000;
  const app = createDiscoveryIndex({
    storage,
    registrations,
    claims: createD1GithubClaimStore(database),
    profiles: createD1SellerProfileStore(database),
    modelRegistry: createD1ModelRegistry(database),
    limiters: allLimiters(),
    now: () => now,
  });
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(INDEX_ORIGIN + path, init));
  const publish = async (signed: SignedPublicV2) =>
    expectStatus(
      await call('/v1/records', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': CLIENT_IP,
        },
        body: JSON.stringify({ record: signed }),
      }),
      CREATED,
    );
  async function admit(node: IndexNode) {
    const hash = await inviteHash(`gyb_${node.nodeId.slice(0, 16)}`);
    await registrations.createInvite({
      inviteHash: hash,
      contact: 'seller@example.com',
      createdAt: now,
      expiresAt: now + HOUR,
    });
    await registrations.redeem({
      inviteHash: hash,
      nodeId: node.nodeId,
      owner: INDEX_OWNER,
      asset: 'asset',
      country: null,
      now,
    });
    return node;
  }
  return { database, storage, call, publish, admit, now };
}

export async function discoveryLoad(): Promise<D1LoadRow[] | null> {
  const index = await productionIndex();
  if (!index) return null;
  const { database, publish } = index;
  await publish((await index.admit(indexNode())).catalog(1));
  const narrow = await index.admit(indexNode());
  const wide = await index.admit(indexNode());
  const narrowCatalog = narrow.catalog(1);
  const wideCatalog = wide.catalog(1, {
    models: Array.from(
      { length: PUBLIC_RECORD_LIMITS.maxModels },
      (_, model) => `${MODEL}-${model}`,
    ),
  });
  const read = (path: string) => async () =>
    expectStatus(await index.call(path), OK);
  const step = (label: D1LoadRow['label'], action: () => Promise<unknown>) =>
    measureD1Step(label, database, action);
  const published = [
    await step(D1_LOAD_LABELS.PUBLISH_CATALOG_1, () => publish(narrowCatalog)),
    await step(D1_LOAD_LABELS.PUBLISH_CATALOG_64, () => publish(wideCatalog)),
  ];
  await publish(await narrow.presence(2, narrowCatalog));
  await publish(await wide.presence(2, wideCatalog));
  return [
    ...published,
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
      rollupNetworkDays(index.storage, index.now),
    ),
  ];
}
