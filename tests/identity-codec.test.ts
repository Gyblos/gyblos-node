// Owns offline identity golden codec cases: public devnet account bytes, pinned instruction bytes and binding vectors.
// No network or funded wallets; fixtures were captured read-only by lab/tools/identity-fixtures.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { address, createNoopSigner } from '@solana/kit';

import { IDENTITY_ERROR_CODES, IdentityError } from '@gyblos/identity';
import {
  decodeAgentAccount,
  decodeCoreAssetOwner,
  decodeMetadataEntry,
} from '@gyblos/identity/accounts';
import {
  decodeBindingValue,
  encodeBindingValue,
  nodeIdToBytes,
  signNodeBinding,
  verifyNodeBinding,
} from '@gyblos/identity/binding';
import { concatBytes, encodeString, encodeVecU8 } from '@gyblos/identity/bytes';
import {
  ACCOUNT_DISCRIMINATORS,
  BINDING,
  METADATA_KEYS,
} from '@gyblos/identity/constants';
import {
  registerInstruction,
  setAgentWalletInstructions,
  setMetadataInstruction,
} from '@gyblos/identity/instructions';
import { findAgentAddress, metadataKeyHash } from '@gyblos/identity/pda';
import { nodeIdMetadataPrefix } from '@gyblos/identity/read';

import {
  bytesOf,
  devnetAccounts,
  fixedSigner,
  hex,
} from './support/identity-fixture.js';

const FIXTURES = devnetAccounts();

const GOLDEN = {
  nodeId: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
  bindingValue:
    '018a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c617adeb78270c24eddef9b152c674def59c8d277be4e66846358e46b2b4694f05f755e8a415607f6ff6766abde93024583a70bd37bf4e8060c1c45befe590204',
  registerData:
    'b1af60293ba60d061900000068747470733a2f2f6779626c6f732e636f6d2f6e2e6a736f6e00',
  setWalletData:
    '9a57fb17330c0496ca93ac1705187071d67b83c7ff0efe8108e8ec4530575d7726879333dbdabe7c00d2496b00000000',
  ed25519Header: '01003000ffff1000ffff70007800ffff',
  agentPda: '9CpCmFPLBwXS7dzK8HhM3eSyieire9pK98ZNe4ndBbR1',
} as const;

async function goldenKeys() {
  return {
    node: await fixedSigner(1),
    owner: await fixedSigner(2),
    asset: await fixedSigner(3),
    wallet: await fixedSigner(4),
  };
}

function isDataError(error: unknown): boolean {
  return (
    error instanceof IdentityError &&
    error.code === IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID
  );
}

void test('decodes a real devnet AgentAccount and its PDA matches the fixture address', async () => {
  const agent = decodeAgentAccount(bytesOf(FIXTURES.agent.base64));
  assert.equal(
    agent.collection,
    '6CTyGPcn8dMwKEqgtvx2XCpkGUd7uqCVK6937RSM5bhA',
  );
  assert.equal(agent.owner, 'Cmsscfv2BPJSGYvGa4QQTUAsGNvWqpPy4z6UdtFM5Uai');
  assert.equal(agent.asset, '6Nyir6EcfrqqEtV935vzbzCUwam64mVNAnkQCyu7apg6');
  assert.equal(agent.creator, 'Ff26VsLhHiL8miieVi5SyadPrzMEf9nWSEH3FvmMvS3E');
  assert.equal(agent.agentWallet, undefined);
  assert.equal(agent.nftName, 'Agent');
  assert.equal(await findAgentAddress(agent.asset), FIXTURES.agent.address);
});

void test('decodes a real devnet MetadataEntryPda', () => {
  const entry = decodeMetadataEntry(bytesOf(FIXTURES.metadata.base64));
  assert.equal(entry.asset, 'KmqkyFGfhrwu1gm1HjgkQGW61mecANEAjMGz8H51wWK');
  assert.equal(entry.key, 'version');
  assert.equal(Buffer.from(entry.value).toString('utf8'), '1.0.0');
});

void test('rejects truncated, mislabelled and malformed account data with a typed error', () => {
  const agent = bytesOf(FIXTURES.agent.base64);
  assert.throws(() => decodeAgentAccount(agent.subarray(0, 100)), isDataError);
  assert.throws(() => decodeMetadataEntry(agent), isDataError);
  const badBool = agent.slice();
  badBool[137] = 7; // atom_enabled
  assert.throws(() => decodeAgentAccount(badBool), isDataError);
  const header = concatBytes([
    ACCOUNT_DISCRIMINATORS.metadata,
    new Uint8Array(34),
  ]);
  const oversizedKey = concatBytes([
    header,
    encodeString('k'.repeat(33)),
    encodeVecU8(new Uint8Array(1)),
  ]);
  assert.throws(() => decodeMetadataEntry(oversizedKey), isDataError);
  const badUtf8 = concatBytes([
    header,
    encodeVecU8(Uint8Array.of(0xff, 0xfe)),
    encodeVecU8(new Uint8Array(1)),
  ]);
  assert.throws(() => decodeMetadataEntry(badUtf8), isDataError);
  assert.throws(() => decodeCoreAssetOwner(new Uint8Array(33)), isDataError);
});

void test('metadata key hash is SHA-256(key)[0..16]', async () => {
  const expected = createHash('sha256')
    .update('gyblos.nodeId')
    .digest()
    .subarray(0, 16);
  assert.equal(
    hex(await metadataKeyHash(METADATA_KEYS.nodeId)),
    expected.toString('hex'),
  );
});

void test('node binding golden vector: encode, decode, verify, and reject a different owner', async () => {
  const keys = await goldenKeys();
  const binding = await signNodeBinding(
    keys.node,
    keys.asset.address,
    keys.owner.address,
  );
  assert.equal(binding.nodeId, GOLDEN.nodeId);
  assert.equal(BINDING.valueBytes, 1 + 32 + 64);
  assert.equal(hex(encodeBindingValue(binding)), GOLDEN.bindingValue);
  const decoded = decodeBindingValue(
    new Uint8Array(Buffer.from(GOLDEN.bindingValue, 'hex')),
  );
  assert.equal(
    await verifyNodeBinding(decoded, keys.asset.address, keys.owner.address),
    true,
  );
  assert.equal(
    await verifyNodeBinding(decoded, keys.asset.address, keys.wallet.address),
    false,
  );
  assert.throws(
    () => nodeIdToBytes('ABC'),
    (error) =>
      error instanceof IdentityError &&
      error.code === IDENTITY_ERROR_CODES.INPUT_INVALID,
  );
});

void test('instruction data golden bytes: register, set_metadata, ed25519 proof, set_agent_wallet', async () => {
  const keys = await goldenKeys();
  const owner = createNoopSigner(keys.owner.address);
  const asset = createNoopSigner(keys.asset.address);
  const register = await registerInstruction(
    owner,
    asset,
    'https://gyblos.com/n.json',
  );
  assert.equal(hex(Uint8Array.from(register.data ?? [])), GOLDEN.registerData);
  assert.equal(register.accounts?.[2]?.address, GOLDEN.agentPda);
  const binding = await signNodeBinding(
    keys.node,
    keys.asset.address,
    keys.owner.address,
  );
  const metadata = await setMetadataInstruction(
    owner,
    keys.asset.address,
    METADATA_KEYS.nodeId,
    encodeBindingValue(binding),
  );
  assert.ok(
    hex(Uint8Array.from(metadata.data ?? [])).includes(GOLDEN.bindingValue),
  );
  const deadline = 1_800_000_000n;
  const [proof, setWallet] = await setAgentWalletInstructions(
    owner,
    keys.asset.address,
    keys.wallet,
    deadline,
  );
  assert.equal(
    hex(Uint8Array.from(proof.data ?? []).subarray(0, 16)),
    GOLDEN.ed25519Header,
  );
  assert.equal(
    hex(Uint8Array.from(setWallet.data ?? [])),
    GOLDEN.setWalletData,
  );
  await assert.rejects(
    registerInstruction(owner, asset, 'x'.repeat(251)),
    IdentityError,
  );
});

void test('nodeId metadata prefix sits at offset 42 of an encoded metadata account', () => {
  const value = new Uint8Array(Buffer.from(GOLDEN.bindingValue, 'hex'));
  const account = concatBytes([
    ACCOUNT_DISCRIMINATORS.metadata,
    new Uint8Array(32),
    Uint8Array.of(0, 255),
    encodeString(METADATA_KEYS.nodeId),
    encodeVecU8(value),
  ]);
  const prefix = nodeIdMetadataPrefix(GOLDEN.nodeId);
  assert.equal(hex(account.subarray(42, 42 + prefix.length)), hex(prefix));
  assert.equal(decodeMetadataEntry(account).key, METADATA_KEYS.nodeId);
  assert.equal(
    address(decodeMetadataEntry(account).asset),
    '11111111111111111111111111111111',
  );
});
