// Rejects malformed local role/trust JSON before keys, offers or network effects can be consumed.
// Every file belongs to a temporary synthetic checkout; no operational role data is read.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET_RPC_URL, MAX_ATOMIC, P2P } from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import {
  NODE_ERROR_CODES,
  P2P_ROLES,
  ROLE_CONFIG_SCHEMA_VERSION,
} from '@gyblos/node/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime.js';

const ADDRESS = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
const ROLE = {
  schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
  role: P2P_ROLES.BUYER,
  assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
  rpcUrl: DEVNET_RPC_URL,
  mint: ADDRESS,
  nodeId: '1'.repeat(64),
  buyer: ADDRESS,
};
const TRUST = {
  owner: ADDRESS,
  nodeId: '2'.repeat(64),
  mint: ADDRESS,
  payTo: ADDRESS,
  buyer: ADDRESS,
  maxAtomic: MAX_ATOMIC,
};

async function withConfig(
  run: (
    write: (file: string, value: unknown) => Promise<void>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-config-'));
  const original = process.cwd();
  try {
    process.chdir(directory);
    await mkdir(P2P.root, { recursive: true });
    const write = (file: string, value: unknown) =>
      writeFile(join(P2P.root, file), JSON.stringify(value));
    await write(P2P.roleConfig, ROLE);
    await run(write);
  } finally {
    process.chdir(original);
    await rm(directory, { recursive: true, force: true });
  }
}

void test(
  'local role loading rejects incomplete records instead of returning asserted configuration',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { loadRole } = await import('@gyblos/node/roles');
    await withConfig(async (write) => {
      await write(P2P.roleConfig, {
        schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
        role: ROLE.role,
        assetLabel: ROLE.assetLabel,
      });
      await assert.rejects(loadRole());
    });
  },
);

void test(
  'local trust rejects non-string budgets before reading the signed offer',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { trustedOffer } = await import('@gyblos/buyer/buyer');
    await withConfig(async (write) => {
      await write(P2P.trustFilename, {
        ...TRUST,
        maxAtomic: Number(MAX_ATOMIC),
      });
      await assert.rejects(trustedOffer(), {
        code: NODE_ERROR_CODES.INVALID_OFFER_TRUST,
      });
    });
  },
);

void test(
  'local role parser accepts both complete roles and rejects malformed required fields',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { parseRoleConfig } = await import('@gyblos/node/roles');
    assert.deepEqual(parseRoleConfig(ROLE), ROLE);
    const seller = {
      ...ROLE,
      role: P2P_ROLES.SELLER,
      owner: ADDRESS,
      facilitator: ADDRESS,
      authorizer: ADDRESS,
      payTo: ADDRESS,
    };
    assert.deepEqual(parseRoleConfig(seller), seller);
    for (const value of [
      null,
      [],
      {},
      { ...ROLE, rpcUrl: 'file:///not-an-rpc' },
      { ...ROLE, mint: 'invalid' },
      { ...ROLE, nodeId: 'invalid' },
      { ...ROLE, buyer: 1 },
      { ...seller, payTo: undefined },
    ])
      assert.throws(() => parseRoleConfig(value), {
        code: NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
      });
  },
);

void test('local trust parser validates identity fields and positive bounded decimal-string budgets', async () => {
  const { parseOfferTrust } = await import('@gyblos/node/offers');
  assert.deepEqual(parseOfferTrust(TRUST), TRUST);
  for (const maxAtomic of [
    null,
    1000,
    '',
    '0',
    '-1',
    '0x10',
    '10001',
    '1000\n',
    'PRIVATE_RPC_CREDENTIAL_SENTINEL',
  ])
    assert.throws(() => parseOfferTrust({ ...TRUST, maxAtomic }), {
      code: NODE_ERROR_CODES.INVALID_OFFER_TRUST,
      message: NODE_ERROR_CODES.INVALID_OFFER_TRUST,
    });
  for (const value of [
    null,
    [],
    {},
    { ...TRUST, owner: false },
    { ...TRUST, nodeId: 'invalid' },
    { ...TRUST, mint: 'invalid' },
    { ...TRUST, buyer: undefined },
  ])
    assert.throws(() => parseOfferTrust(value), {
      code: NODE_ERROR_CODES.INVALID_OFFER_TRUST,
    });
});

void test(
  'malformed local JSON never exposes credential snippets in validation errors',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { loadRole } = await import('@gyblos/node/roles');
    const { trustedOffer } = await import('@gyblos/buyer/buyer');
    await withConfig(async (write) => {
      const malformed = 'https://PRIVATE_RPC_CREDENTIAL_SENTINEL';
      await writeFile(join(P2P.root, P2P.roleConfig), malformed);
      await assert.rejects(loadRole(), {
        code: NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
        message: NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
      });
      await write(P2P.roleConfig, ROLE);
      await writeFile(join(P2P.root, P2P.trustFilename), malformed);
      await assert.rejects(trustedOffer(), {
        code: NODE_ERROR_CODES.INVALID_OFFER_TRUST,
        message: NODE_ERROR_CODES.INVALID_OFFER_TRUST,
      });
    });
  },
);

void test(
  'role setup rejects an invalid RPC URL before creating keys or configuration',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { setupRole } = await import('@gyblos/node/roles');
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-invalid-role-'));
    const original = process.cwd();
    const previousRpc = process.env.GYBLOS_RPC_URL;
    try {
      process.chdir(directory);
      process.env.GYBLOS_RPC_URL = 'file:///PRIVATE_RPC_CREDENTIAL_SENTINEL';
      await assert.rejects(
        setupRole({ role: P2P_ROLES.BUYER, mint: ADDRESS }),
        { code: NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION },
      );
      const { lstat } = await import('node:fs/promises');
      await assert.rejects(lstat(P2P.root), { code: 'ENOENT' });
    } finally {
      if (previousRpc === undefined) delete process.env.GYBLOS_RPC_URL;
      else process.env.GYBLOS_RPC_URL = previousRpc;
      process.chdir(original);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'local role and trust reject uppercase NodeIds before offer matching',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { parseRoleConfig } = await import('@gyblos/node/roles');
    const { parseOfferTrust } = await import('@gyblos/node/offers');
    const lowercase = 'ab'.repeat(32);
    assert.equal(
      parseRoleConfig({ ...ROLE, nodeId: lowercase }).nodeId,
      lowercase,
    );
    assert.equal(
      parseOfferTrust({ ...TRUST, nodeId: lowercase }).nodeId,
      lowercase,
    );
    assert.throws(
      () => parseRoleConfig({ ...ROLE, nodeId: lowercase.toUpperCase() }),
      {
        code: NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
      },
    );
    assert.throws(
      () => parseOfferTrust({ ...TRUST, nodeId: lowercase.toUpperCase() }),
      {
        code: NODE_ERROR_CODES.INVALID_OFFER_TRUST,
      },
    );
  },
);
