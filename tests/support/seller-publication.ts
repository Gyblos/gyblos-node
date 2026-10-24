// Creates public-record/publisher fixtures in isolated seller homes, with ephemeral unfunded signers.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSellerRecords } from '@gyblos/node/public-records';
import { openSellerSequence } from '@gyblos/node/public-sequence';
import type { Signer } from '@gyblos/protocol/signing';

import { controlFixture } from './control-fixture.js';

export async function sellerPublicationFixture(identity?: {
  nodeId: string;
  signer: Signer;
}) {
  const source = await controlFixture();
  if (identity) {
    source.catalog.nodeId = identity.nodeId;
    source.context.nodeId = identity.nodeId;
    source.nodeSigner = async (bytes) =>
      Uint8Array.from(await identity.signer(bytes));
  }
  const directory = await mkdtemp(join(tmpdir(), 'seller-publication-'));
  const environment = { GYBLOS_HOME: directory };
  const sequence = await openSellerSequence({
    environment,
    nodeId: source.catalog.nodeId,
    initialFloor: source.catalog.sequence + 1,
  });
  const records = await createSellerRecords({
    template: source.catalog,
    sequence,
    signer: source.nodeSigner,
    now: source.context.now,
    validUntil: () => source.context.readiness().validUntil,
    catalogMs: 6000,
    renewBeforeMs: 2000,
  });
  return {
    ...source,
    records,
    environment,
    directory,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
