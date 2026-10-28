// Protects persistent replay high-water marks, forks and withdrawal tombstones across restarts.
// All records/signers are synthetic and all files stay in temporary buyer homes.
import assert from 'node:assert/strict';
import {
  chmod,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  BUYER_DISCOVERY,
  BUYER_SELECTION_CODES,
} from '@gyblos/buyer/constants';
import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { homeLayout } from '@gyblos/config/home';
import { CONTROL_CODES, PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';

import { discoveryHome, discoveryRun } from './support/buyer-discovery';

void test('discovery replay metadata survives restart and permits only identical equal-sequence refresh', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    assert.equal(await home.state.observe(run.known), true);
    const restarted = await buyerDiscoveryState(home.environment);
    assert.equal(await restarted.observe(run.known), true);
    assert.equal(
      restarted.eligible(run.config.sellers, run.context.now()).length,
      1,
    );
    const fork = {
      ...run.known,
      presence: {
        ...run.known.presence!,
        issuedAt: run.known.presence!.issuedAt + 1,
      },
    };
    assert.equal(await restarted.observe(fork), false);
    assert.equal(
      (await buyerDiscoveryState(home.environment)).eligible(
        run.config.sellers,
        run.context.now(),
      ).length,
      0,
    );
    const path = join(
      homeLayout(home.environment).roles.buyer,
      BUYER_DISCOVERY.stateFile,
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(homeLayout(home.environment).roles.buyer)).mode & 0o777,
      0o700,
    );
    const stored = await readFile(path, 'utf8');
    assert.equal(stored.includes('prompt'), false);
    assert.equal(stored.includes('signature'), false);
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('withdrawal tombstones survive restart and expiry; only a later catalog reopens the node', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const withdrawn = {
      ...run.known,
      withdrawal: {
        schemaVersion: run.catalog.schemaVersion,
        kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
        owner: run.catalog.owner,
        nodeId: run.catalog.nodeId,
        sequence: 10,
        issuedAt: run.context.now(),
        expiresAt: run.context.now() + 1000,
        catalogDigest: run.request.params.catalogDigest,
      },
    };
    assert.equal(await home.state.observe(withdrawn), false);
    const state = await buyerDiscoveryState(home.environment);
    assert.equal(
      state.eligible(run.config.sellers, run.context.now() + 2000).length,
      0,
    );
    assert.equal(
      await state.observe({
        ...run.known,
        presence: { ...run.known.presence!, sequence: 11 },
      }),
      false,
    );
    const newer = {
      ...run.known,
      catalog: { ...run.catalog, sequence: 12 },
      presence: { ...run.known.presence!, sequence: 13 },
    };
    assert.equal(await state.observe(newer), true);
    assert.equal(
      state.eligible(run.config.sellers, run.context.now()).length,
      1,
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('older catalogs and lower global sequences cannot replace accepted discovery state', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    await home.state.observe({
      ...run.known,
      catalog: { ...run.catalog, sequence: 10 },
      presence: { ...run.known.presence!, sequence: 11 },
    });
    assert.equal(await home.state.observe(run.known), false);
    assert.equal(
      await home.state.observe({
        ...run.known,
        presence: { ...run.known.presence!, sequence: 100 },
      }),
      false,
    );
    assert.equal(
      await home.state.observe({
        ...run.known,
        catalog: { ...run.catalog, sequence: 12 },
        presence: { ...run.known.presence!, sequence: 13 },
      }),
      false,
    );
    assert.equal(
      home.state.eligible(run.config.sellers, run.context.now()).length,
      0,
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('discovery state refuses permissive directories, symlink files and malformed namespaces', async () => {
  const home = await discoveryHome();
  try {
    const directory = homeLayout(home.environment).roles.buyer;
    await chmod(directory, 0o755);
    await assert.rejects(buyerDiscoveryState(home.environment), {
      code: BUYER_SELECTION_CODES.DISCOVERY_STATE,
    });
    await chmod(directory, 0o700);
    const path = join(directory, BUYER_DISCOVERY.stateFile);
    const target = join(home.directory, 'synthetic-state');
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(buyerDiscoveryState(home.environment), {
      code: BUYER_SELECTION_CODES.DISCOVERY_STATE,
    });
  } finally {
    await home.close();
  }
});
void test('a held discovery lock fails closed and never removes another process lock', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  const path = join(
    homeLayout(home.environment).roles.buyer,
    BUYER_DISCOVERY.lockFile,
  );
  const lock = await open(path, 'wx', 0o600);
  try {
    await assert.rejects(home.state.observe(run.known), {
      code: BUYER_SELECTION_CODES.DISCOVERY_STATE,
    });
    assert.ok(await stat(path));
    assert.throws(
      () => home.state.eligible(run.config.sellers, run.context.now()),
      { code: BUYER_SELECTION_CODES.DISCOVERY_STATE },
    );
  } finally {
    await lock.close();
    await run.wire.close();
    await home.close();
  }
});
void test('concurrent in-process observations serialize and preserve the highest state on disk', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const results = await Promise.all([
      home.state.observe(run.known),
      home.state.observe({
        ...run.known,
        presence: { ...run.known.presence!, sequence: 3 },
      }),
    ]);
    assert.equal(results.includes(true), true);
    const state = await buyerDiscoveryState(home.environment);
    assert.equal(await state.observe(run.known), false);
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('a zero catalog sequence is rejected by the protocol before replay state changes', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    await assert.rejects(
      home.state.observe({
        ...run.known,
        catalog: { ...run.catalog, sequence: 0 },
        presence: { ...run.known.presence!, sequence: 1 },
      }),
      { code: CONTROL_CODES.INVALID },
    );
    assert.equal(
      home.state.eligible(run.config.sellers, run.context.now()).length,
      0,
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('permissive replay files and a foreign record namespace fail closed', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    await home.state.observe(run.known);
    const path = join(
      homeLayout(home.environment).roles.buyer,
      BUYER_DISCOVERY.stateFile,
    );
    await chmod(path, 0o644);
    await assert.rejects(buyerDiscoveryState(home.environment), {
      code: BUYER_SELECTION_CODES.DISCOVERY_STATE,
    });
    await chmod(path, 0o600);
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(
      path,
      JSON.stringify({ ...(value as object), recordVersion: 1 }),
    );
    await assert.rejects(buyerDiscoveryState(home.environment), {
      code: BUYER_SELECTION_CODES.DISCOVERY_STATE,
    });
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('a replay file disappearing while open cannot silently reset accepted high-water state', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    await home.state.observe(run.known);
    await rm(
      join(homeLayout(home.environment).roles.buyer, BUYER_DISCOVERY.stateFile),
    );
    await assert.rejects(home.state.observe(run.known), {
      code: BUYER_SELECTION_CODES.DISCOVERY_STATE,
    });
  } finally {
    await run.wire.close();
    await home.close();
  }
});
