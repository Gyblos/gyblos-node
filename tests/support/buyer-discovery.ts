// Creates isolated buyer homes and signed discovery snapshots for integration tests.
// Only ephemeral unfunded signers, temporary metadata and loopback control streams are used.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { homeLayout } from '@gyblos/config/home';
import { SELLER_BADGES } from '@gyblos/core/constants';
import type { KnownSeller } from '@gyblos/core/seller-selection';

import { selectionFixture } from './buyer-selection.js';

export async function discoveryHome() {
  const directory = await mkdtemp(join(tmpdir(), 'buyer-discovery-'));
  const environment = { GYBLOS_HOME: directory };
  await mkdir(homeLayout(environment).roles.buyer, { mode: 0o700 });
  return {
    environment,
    directory,
    state: await buyerDiscoveryState(environment),
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function discoveryRun() {
  const run = await selectionFixture();
  const signedCatalog = await run.client.getCatalog();
  const signedPresence = await run.client.getPresence();
  if (
    signedCatalog.record.kind !== 'catalog' ||
    signedPresence.record.kind !== 'presence'
  )
    throw new Error('Invalid synthetic record.');
  const known: KnownSeller = {
    catalog: signedCatalog.record,
    presence: signedPresence.record,
    withdrawal: null,
    badge: SELLER_BADGES.DECLARED_USAGE,
    openChannel: false,
  };
  const entry = { catalog: signedCatalog, presence: signedPresence };
  const config = {
    ...run.config,
    discovery: { baseUrl: 'https://index.test/api/v1/discovery', maxPages: 3 },
  };
  return { ...run, entry, known, config };
}
export const discoveryResponse = (
  sellers: unknown[],
  next: string | null = null,
) =>
  new Response(JSON.stringify({ sellers, next, generatedAt: 0 }), {
    status: 200,
  });
