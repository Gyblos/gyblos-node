// Checks the local home layout (env, defaults, buyer/seller separation) and the fail-closed legacy
// guard. Every path lives in a synthetic temporary directory; legacy contents are never read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_HOMES,
  HOME_ENVIRONMENT,
  homeLayout,
  labLayout,
  LEGACY_LOCAL_PATHS,
  ROLE_DIRECTORIES,
  type HomeRole,
} from '@gyblos/config';
import {
  NODE_ERROR_CODES,
  P2P_ROLES,
  type P2PRole,
} from '@gyblos/node/constants';
import {
  assertOllamaModelsHome,
  assertRoleHome,
  assertTokenizerHome,
} from '@gyblos/node/home';

import { NATIVE_CAPABILITY } from './support/native-runtime';

const DEFAULT_ENV = {};

async function inTemporaryCwd(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-home-test-'));
  const original = process.cwd();
  try {
    process.chdir(directory);
    await run(directory);
  } finally {
    process.chdir(original);
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

function legacyError(legacyPath: string, homePath: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(
      (error as Error & { code?: string }).code,
      NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
    );
    assert.ok(error.message.includes(legacyPath), error.message);
    assert.ok(error.message.includes(homePath), error.message);
    return true;
  };
}

void test('home layout defaults to one cwd-relative product home and a separate lab home', () => {
  const layout = homeLayout(DEFAULT_ENV);
  assert.equal(layout.root, '.local/gyblos');
  assert.equal(layout.roles.buyer, '.local/gyblos/buyer');
  assert.equal(layout.roles.seller, '.local/gyblos/seller');
  assert.equal(layout.artifacts.tokenizer, '.local/gyblos/artifacts/tokenizer');
  assert.deepEqual(layout.artifacts.tokenizerFiles, {
    tokenizer: '.local/gyblos/artifacts/tokenizer/tokenizer.json',
    config: '.local/gyblos/artifacts/tokenizer/tokenizer_config.json',
  });
  assert.equal(
    layout.artifacts.ollamaModels,
    '.local/gyblos/artifacts/ollama-models',
  );
  assert.deepEqual(labLayout(DEFAULT_ENV), {
    root: '.local/lab',
    measurements: '.local/lab/measurements.jsonl',
    facilitatorDiagnostics: '.local/lab/facilitator-diagnostics',
    identityKeys: '.local/lab/identity/keys',
    identityValidator: '.local/lab/identity-validator',
  });
  assert.equal(DEFAULT_HOMES.product, layout.root);
});

void test('home layout follows GYBLOS_HOME and GYBLOS_LAB_HOME; empty values use the defaults', () => {
  const env = {
    [HOME_ENVIRONMENT.product]: '/data',
    [HOME_ENVIRONMENT.lab]: '/lab-data',
  };
  assert.equal(HOME_ENVIRONMENT.product, 'GYBLOS_HOME');
  assert.equal(HOME_ENVIRONMENT.lab, 'GYBLOS_LAB_HOME');
  assert.equal(homeLayout(env).roles.buyer, '/data/buyer');
  assert.equal(homeLayout(env).roles.seller, '/data/seller');
  assert.equal(
    homeLayout(env).artifacts.ollamaModels,
    '/data/artifacts/ollama-models',
  );
  assert.equal(labLayout(env).root, '/lab-data');
  assert.equal(labLayout(env).measurements, '/lab-data/measurements.jsonl');
  const empty = { GYBLOS_HOME: '', GYBLOS_LAB_HOME: '' };
  assert.equal(homeLayout(empty).root, DEFAULT_HOMES.product);
  assert.equal(labLayout(empty).root, DEFAULT_HOMES.lab);
});

void test('buyer, seller, artifacts and lab state never share a directory', () => {
  const layout = homeLayout(DEFAULT_ENV);
  const directories = [
    layout.roles.buyer,
    layout.roles.seller,
    layout.artifacts.root,
    labLayout(DEFAULT_ENV).root,
  ];
  for (const directory of directories)
    for (const other of directories)
      if (directory !== other)
        assert.equal(
          other.startsWith(`${directory}/`),
          false,
          `${other} is inside ${directory}`,
        );
  assert.equal(new Set(directories).size, directories.length);
});

// Config cannot import node, so the home role set and the node role set are pinned here instead.
void test('home role directories match the node roles exactly', () => {
  type SameRoles = [HomeRole] extends [P2PRole]
    ? [P2PRole] extends [HomeRole]
      ? true
      : false
    : false;
  const sameRoles: SameRoles = true;
  assert.equal(sameRoles, true);
  const nodeRoles = Object.values(P2P_ROLES).sort();
  assert.deepEqual(Object.keys(ROLE_DIRECTORIES).sort(), nodeRoles);
  assert.deepEqual(Object.values(ROLE_DIRECTORIES).sort(), nodeRoles);
  assert.deepEqual(
    Object.keys(homeLayout(DEFAULT_ENV).roles).sort(),
    nodeRoles,
  );
});

void test('a fresh home passes the legacy guard for every role and artifact', async () => {
  await inTemporaryCwd(async () => {
    await assertRoleHome(P2P_ROLES.BUYER, DEFAULT_ENV);
    await assertRoleHome(P2P_ROLES.SELLER, DEFAULT_ENV);
    await assertTokenizerHome(DEFAULT_ENV);
    await assertOllamaModelsHome(DEFAULT_ENV);
  });
});

void test('legacy role data blocks both roles until the new role directory exists', async () => {
  await inTemporaryCwd(async () => {
    await mkdir(LEGACY_LOCAL_PATHS.roles, { recursive: true });
    const layout = homeLayout(DEFAULT_ENV);
    for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER])
      await assert.rejects(
        assertRoleHome(role, DEFAULT_ENV),
        legacyError(LEGACY_LOCAL_PATHS.roles, layout.roles[role]),
      );
    await mkdir(layout.roles.buyer, { recursive: true });
    await assertRoleHome(P2P_ROLES.BUYER, DEFAULT_ENV);
    await assert.rejects(assertRoleHome(P2P_ROLES.SELLER, DEFAULT_ENV), {
      code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
    });
  });
});

void test('legacy tokenizer and Ollama model caches block their artifact directories', async () => {
  await inTemporaryCwd(async () => {
    const layout = homeLayout(DEFAULT_ENV);
    await mkdir(LEGACY_LOCAL_PATHS.tokenizer, { recursive: true });
    await assert.rejects(
      assertTokenizerHome(DEFAULT_ENV),
      legacyError(LEGACY_LOCAL_PATHS.tokenizer, layout.artifacts.tokenizer),
    );
    await assertOllamaModelsHome(DEFAULT_ENV);
    await mkdir(LEGACY_LOCAL_PATHS.ollamaModels, { recursive: true });
    await assert.rejects(
      assertOllamaModelsHome(DEFAULT_ENV),
      legacyError(
        LEGACY_LOCAL_PATHS.ollamaModels,
        layout.artifacts.ollamaModels,
      ),
    );
    await assertRoleHome(P2P_ROLES.BUYER, DEFAULT_ENV);
  });
});

void test('an explicit GYBLOS_HOME still refuses legacy data in the working directory', async () => {
  await inTemporaryCwd(async (directory) => {
    const env = { GYBLOS_HOME: join(directory, 'data') };
    await mkdir(LEGACY_LOCAL_PATHS.roles, { recursive: true });
    await assert.rejects(
      assertRoleHome(P2P_ROLES.BUYER, env),
      legacyError(LEGACY_LOCAL_PATHS.roles, homeLayout(env).roles.buyer),
    );
  });
});

void test('legacy detection never opens a FIFO or an unreadable legacy path', async () => {
  await inTemporaryCwd(async () => {
    await mkdir('.local/devnet', { recursive: true });
    await mkdir('.local/ollama', { recursive: true });
    // Opening a FIFO without a writer would hang; lstat must not.
    execFileSync('mkfifo', [LEGACY_LOCAL_PATHS.roles]);
    await writeFile(LEGACY_LOCAL_PATHS.tokenizer, 'synthetic');
    await chmod(LEGACY_LOCAL_PATHS.tokenizer, 0o000);
    await mkdir(LEGACY_LOCAL_PATHS.ollamaModels);
    await chmod(LEGACY_LOCAL_PATHS.ollamaModels, 0o000);
    try {
      await assert.rejects(assertRoleHome(P2P_ROLES.BUYER, DEFAULT_ENV), {
        code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
      });
      await assert.rejects(assertTokenizerHome(DEFAULT_ENV), {
        code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
      });
      await assert.rejects(assertOllamaModelsHome(DEFAULT_ENV), {
        code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
      });
    } finally {
      await chmod(LEGACY_LOCAL_PATHS.ollamaModels, 0o700);
    }
  });
});

void test(
  'role setup refuses to create a fresh role next to legacy role data',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { setupRole, loadRole } = await import('@gyblos/node/roles');
    const previous = process.env.GYBLOS_HOME;
    await inTemporaryCwd(async (directory) => {
      process.env.GYBLOS_HOME = join(directory, 'home');
      await mkdir(LEGACY_LOCAL_PATHS.roles, { recursive: true });
      const mint = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
      await assert.rejects(setupRole({ role: P2P_ROLES.BUYER, mint }), {
        code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
      });
      await assert.rejects(loadRole(P2P_ROLES.SELLER), {
        code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
      });
      await assert.rejects(lstat(homeLayout(process.env).root), {
        code: 'ENOENT',
      });
    }).finally(() => {
      if (previous === undefined) delete process.env.GYBLOS_HOME;
      else process.env.GYBLOS_HOME = previous;
    });
  },
);

void test(
  'buyer call and reconcile refuse legacy role data before taking a lock',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { main: paidCall } = await import('@gyblos/buyer/call');
    const { main: reconcile } = await import('@gyblos/buyer/reconcile');
    const previous = process.env.GYBLOS_HOME;
    await inTemporaryCwd(async (directory) => {
      process.env.GYBLOS_HOME = join(directory, 'home');
      await mkdir(LEGACY_LOCAL_PATHS.roles, { recursive: true });
      await assert.rejects(paidCall(), {
        code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
      });
      await assert.rejects(reconcile([]), {
        code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
      });
      await assert.rejects(lstat(homeLayout(process.env).root), {
        code: 'ENOENT',
      });
    }).finally(() => {
      if (previous === undefined) delete process.env.GYBLOS_HOME;
      else process.env.GYBLOS_HOME = previous;
    });
  },
);

void test(
  'seller start refuses legacy role data before its first status write',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { createNode } = await import('@gyblos/node');
    const previous = process.env.GYBLOS_HOME;
    await inTemporaryCwd(async (directory) => {
      process.env.GYBLOS_HOME = join(directory, 'home');
      await mkdir(LEGACY_LOCAL_PATHS.roles, { recursive: true });
      await assert.rejects(createNode().start(), {
        code: NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT,
      });
      await assert.rejects(lstat(homeLayout(process.env).roles.seller), {
        code: 'ENOENT',
      });
    }).finally(() => {
      if (previous === undefined) delete process.env.GYBLOS_HOME;
      else process.env.GYBLOS_HOME = previous;
    });
  },
);

void test(
  'buyer and seller set up in one home keep separate role directories',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { generateKeyPairSigner } = await import('@solana/kit');
    const { setupRole } = await import('@gyblos/node/roles');
    const { readdir } = await import('node:fs/promises');
    const previous = process.env.GYBLOS_HOME;
    const mint = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
    await inTemporaryCwd(async (directory) => {
      process.env.GYBLOS_HOME = join(directory, 'home');
      const buyer = await setupRole({ role: P2P_ROLES.BUYER, mint });
      const seller = await setupRole({
        role: P2P_ROLES.SELLER,
        mint,
        buyer: buyer.buyer,
        payTo: (await generateKeyPairSigner()).address,
      });
      assert.notEqual(buyer.nodeId, seller.nodeId);
      const layout = homeLayout(process.env);
      assert.deepEqual((await readdir(layout.root)).sort(), [
        P2P_ROLES.BUYER,
        P2P_ROLES.SELLER,
      ]);
      assert.deepEqual((await readdir(layout.roles.buyer)).sort(), [
        'buyer.json',
        'node.key',
        'role.json',
      ]);
      assert.deepEqual((await readdir(layout.roles.seller)).sort(), [
        'authorizer.json',
        'facilitator.json',
        'node.key',
        'owner.json',
        'role.json',
      ]);
    }).finally(() => {
      if (previous === undefined) delete process.env.GYBLOS_HOME;
      else process.env.GYBLOS_HOME = previous;
    });
  },
);
