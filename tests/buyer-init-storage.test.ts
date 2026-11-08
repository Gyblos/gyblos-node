// Private initial configuration publication, restart and concurrency in fresh synthetic homes only.
import assert from 'node:assert/strict';
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { DEVNET_USDC, FILE_MODES, ROLE_FILES } from '@gyblos/config';
import { initializeBuyer } from '@gyblos/node/buyer-init';
import { BUYER_INIT_CODES } from '@gyblos/node/buyer-init-constants';
import { setupRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { answers, home, owner, role, sellerNodeId } from './support/buyer-init';

void test('shared initialization writes private runtime-loadable settings and preserves unrelated state', async () => {
  const fixture = await home();
  try {
    const result = await initializeBuyer(answers(), {
      environment: fixture.environment,
      prepareRole: async () => role(),
    });
    assert.equal(result.path, fixture.path);
    assert.equal(result.buyer, owner);
    assert.equal(
      parseBuyerSelectionConfig(
        JSON.parse(await readFile(fixture.path, 'utf8')),
      ).request.maxAtomic,
      '0',
    );
    assert.equal(
      (await stat(fixture.path)).mode & FILE_MODES.permissionMask,
      FILE_MODES.privateFile,
    );
    assert.equal(
      (await stat(join(fixture.path, '..'))).mode & FILE_MODES.permissionMask,
      FILE_MODES.privateDirectory,
    );
    assert.deepEqual(await readdir(join(fixture.path, '..')), [
      ROLE_FILES.buyerSelection,
    ]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('existing selection is refused without opening it or preparing a role', async () => {
  const fixture = await home();
  let prepares = 0;
  try {
    await mkdir(join(fixture.path, '..'), {
      recursive: true,
      mode: FILE_MODES.privateDirectory,
    });
    await writeFile(fixture.path, 'existing synthetic config', {
      mode: FILE_MODES.privateFile,
    });
    await assert.rejects(
      initializeBuyer(answers(), {
        environment: fixture.environment,
        prepareRole: async () => {
          prepares++;
          return role();
        },
      }),
      { code: BUYER_INIT_CODES.EXISTS },
    );
    assert.equal(prepares, 0);
    assert.equal(
      await readFile(fixture.path, 'utf8'),
      'existing synthetic config',
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('a destination created during role preparation is never overwritten', async () => {
  const fixture = await home();
  try {
    await assert.rejects(
      initializeBuyer(answers(), {
        environment: fixture.environment,
        prepareRole: async () => {
          await writeFile(fixture.path, 'concurrent synthetic config', {
            mode: FILE_MODES.privateFile,
          });
          return role();
        },
      }),
      { code: BUYER_INIT_CODES.UNAVAILABLE },
    );
    assert.equal(
      await readFile(fixture.path, 'utf8'),
      'concurrent synthetic config',
    );
    assert.deepEqual(await readdir(join(fixture.path, '..')), [
      ROLE_FILES.buyerSelection,
    ]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('concurrent initializers commit exactly once and release their setup lock', async () => {
  const fixture = await home();
  let prepares = 0;
  const options = {
    environment: fixture.environment,
    prepareRole: async () => {
      prepares++;
      return role();
    },
  };
  try {
    const results = await Promise.allSettled([
      initializeBuyer(answers(), options),
      initializeBuyer(answers(), options),
    ]);
    assert.equal(
      results.filter((item) => item.status === 'fulfilled').length,
      1,
    );
    assert.equal(prepares, 1);
    assert.deepEqual(await readdir(join(fixture.path, '..')), [
      ROLE_FILES.buyerSelection,
    ]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('symlinked buyer homes and existing symlink destinations fail closed', async () => {
  const fixture = await home();
  try {
    const outside = join(fixture.directory, 'outside');
    await mkdir(outside, { mode: FILE_MODES.privateDirectory });
    await mkdir(fixture.environment.GYBLOS_HOME, {
      mode: FILE_MODES.privateDirectory,
    });
    await symlink(outside, join(fixture.path, '..'));
    await assert.rejects(
      initializeBuyer(answers(), {
        environment: fixture.environment,
        prepareRole: async () => role(),
      }),
      { code: BUYER_INIT_CODES.UNAVAILABLE },
    );
    assert.deepEqual(await readdir(outside), []);
    await rm(join(fixture.path, '..'));
    await mkdir(join(fixture.path, '..'), {
      mode: FILE_MODES.privateDirectory,
    });
    const target = join(outside, 'untouched');
    await writeFile(target, 'synthetic sentinel');
    await symlink(target, fixture.path);
    await assert.rejects(
      initializeBuyer(answers(), {
        environment: fixture.environment,
        prepareRole: async () => role(),
      }),
      { code: BUYER_INIT_CODES.EXISTS },
    );
    assert.equal(await readFile(target, 'utf8'), 'synthetic sentinel');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('invalid input creates neither home nor role and a wrong prepared role cannot save settings', async () => {
  const fixture = await home();
  let prepares = 0;
  try {
    await assert.rejects(
      initializeBuyer(
        { ...answers(), sellerNodeId: '' },
        {
          environment: fixture.environment,
          prepareRole: async () => {
            prepares++;
            return role();
          },
        },
      ),
      { code: BUYER_INIT_CODES.INVALID },
    );
    assert.equal(prepares, 0);
    await assert.rejects(stat(fixture.environment.GYBLOS_HOME), {
      code: 'ENOENT',
    });
    await assert.rejects(
      initializeBuyer(answers(), {
        environment: fixture.environment,
        prepareRole: async () => ({ ...role(), mint: owner }),
      }),
      { code: BUYER_INIT_CODES.UNAVAILABLE },
    );
    await assert.rejects(stat(fixture.path), { code: 'ENOENT' });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('a real fresh role is reused on a later setup and the generated selection loads unchanged', async () => {
  const fixture = await home();
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = fixture.environment.GYBLOS_HOME;
  try {
    const prepareRole = () =>
      setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC });
    const result = await initializeBuyer(answers(), {
      environment: fixture.environment,
      prepareRole,
    });
    const config = await prepareRole();
    assert.equal(result.nodeId, config.nodeId);
    assert.equal(config.role, P2P_ROLES.BUYER);
    assert.equal(
      parseBuyerSelectionConfig(
        JSON.parse(await readFile(fixture.path, 'utf8')),
      ).sellers[0]?.nodeId,
      sellerNodeId,
    );
  } finally {
    if (previous === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previous;
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('cancelled initialization refuses before creating a home or preparing a role', async () => {
  const fixture = await home();
  let prepares = 0;
  try {
    await assert.rejects(
      initializeBuyer(answers(), {
        environment: fixture.environment,
        signal: AbortSignal.abort(),
        prepareRole: async () => {
          prepares++;
          return role();
        },
      }),
      { code: BUYER_INIT_CODES.UNAVAILABLE },
    );
    assert.equal(prepares, 0);
    await assert.rejects(stat(fixture.environment.GYBLOS_HOME), {
      code: 'ENOENT',
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('cancellation during identity preparation cannot publish settings or leave the init lock', async () => {
  const fixture = await home();
  const controller = new AbortController();
  try {
    await assert.rejects(
      initializeBuyer(answers(), {
        environment: fixture.environment,
        signal: controller.signal,
        prepareRole: async () => {
          controller.abort();
          return role();
        },
      }),
      { code: BUYER_INIT_CODES.UNAVAILABLE },
    );
    assert.deepEqual(await readdir(join(fixture.path, '..')), []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('an existing synthetic buyer identity and payment state stay byte-identical during initialization', async () => {
  const fixture = await home();
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = fixture.environment.GYBLOS_HOME;
  try {
    const prepareRole = () =>
      setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC });
    await prepareRole();
    const parent = join(fixture.path, '..');
    await writeFile(
      join(parent, ROLE_FILES.journal),
      'synthetic unresolved sentinel',
      { mode: FILE_MODES.privateFile },
    );
    const names = await readdir(parent);
    const before = await Promise.all(
      names.map((name) => readFile(join(parent, name))),
    );
    await initializeBuyer(answers(), {
      environment: fixture.environment,
      prepareRole,
    });
    for (const [index, name] of names.entries())
      assert.equal(
        (await readFile(join(parent, name))).equals(before[index]!),
        true,
        'Existing role state changed',
      );
  } finally {
    if (previous === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previous;
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
