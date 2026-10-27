// Owns offline identity golden codec cases: public devnet account bytes, pinned instruction bytes and binding vectors.
// No network or funded wallets; fixtures were captured read-only by lab/tools/identity-fixtures.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { address, createNoopSigner } from '@solana/kit';

import {
  BINDING_VERSIONS,
  IDENTITY_ERROR_CODES,
  IdentityError,
  type IdentityErrorCode,
} from '@gyblos/identity';
import {
  concatBytes,
  decodeAgentAccount,
  decodeBindingValue,
  decodeCoreAssetOwner,
  decodeMetadataEntry,
  encodeBindingValue,
  encodeString,
  encodeU64,
  encodeVecU8,
  findAgentAddress,
  metadataKeyHash,
  nodeIdMetadataPrefix,
  nodeIdToBytes,
  registerInstruction,
  setAgentWalletInstructions,
  setMetadataInstruction,
  signNodeBinding,
  verifyNodeBinding,
} from '@gyblos/identity/codec';
import {
  ACCOUNT_DISCRIMINATORS,
  BINDING_LAYOUTS,
  METADATA_KEYS,
} from '@gyblos/identity/constants';

import {
  bytesOf,
  devnetAccounts,
  fixedSigner,
  hex,
} from './support/identity-fixture';

const FIXTURES = devnetAccounts();

const GOLDEN = {
  nodeId: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
  // v2 value for sequence 7: version ‖ nodeId ‖ u64 LE sequence ‖ signature.
  bindingSequence: 7n,
  bindingValue:
    '028a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c070000000000000039f93c39250788c46cb01a8f3b4fa0f61eb2faea21a248be91ababa0928a9e6d123076ba1358e3a35bfead69b5048f4d5029788bd32177818bae2fbcadbde609',
  // Historical v1 value (no sequence) written before v2; still readable as sequence 0.
  legacyBindingValue:
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

function hasCode(code: IdentityErrorCode) {
  return (error: unknown) =>
    error instanceof IdentityError && error.code === code;
}

const isDataError = hasCode(IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID);
const isBindingError = hasCode(IDENTITY_ERROR_CODES.BINDING_INVALID);

function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

async function goldenBinding(keys: Awaited<ReturnType<typeof goldenKeys>>) {
  return signNodeBinding(keys.node, {
    asset: keys.asset.address,
    owner: keys.owner.address,
    sequence: GOLDEN.bindingSequence,
  });
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
  const binding = await goldenBinding(keys);
  assert.equal(binding.nodeId, GOLDEN.nodeId);
  assert.equal(
    BINDING_LAYOUTS[BINDING_VERSIONS.V2].valueBytes,
    1 + 32 + 8 + 64,
  );
  assert.equal(hex(encodeBindingValue(binding)), GOLDEN.bindingValue);
  const decoded = decodeBindingValue(fromHex(GOLDEN.bindingValue));
  assert.equal(decoded.version, BINDING_VERSIONS.V2);
  assert.equal(decoded.sequence, GOLDEN.bindingSequence);
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
    hasCode(IDENTITY_ERROR_CODES.INPUT_INVALID),
  );
});

void test('a tampered binding sequence no longer verifies', async () => {
  const keys = await goldenKeys();
  const value = encodeBindingValue(await goldenBinding(keys));
  value.set(encodeU64(GOLDEN.bindingSequence + 1n), 1 + 32);
  const tampered = decodeBindingValue(value);
  assert.equal(tampered.sequence, GOLDEN.bindingSequence + 1n);
  assert.equal(
    await verifyNodeBinding(tampered, keys.asset.address, keys.owner.address),
    false,
  );
});

void test('a legacy v1 binding decodes as sequence 0 and still verifies, but is never written', async () => {
  const keys = await goldenKeys();
  const legacy = decodeBindingValue(fromHex(GOLDEN.legacyBindingValue));
  assert.equal(legacy.version, BINDING_VERSIONS.V1);
  assert.equal(legacy.sequence, 0n);
  assert.equal(legacy.nodeId, GOLDEN.nodeId);
  assert.equal(
    await verifyNodeBinding(legacy, keys.asset.address, keys.owner.address),
    true,
  );
  assert.throws(() => encodeBindingValue(legacy), isBindingError);
});

void test('binding values with an unknown version, a mismatched length or no bytes are rejected', () => {
  const current = fromHex(GOLDEN.bindingValue);
  const unknownVersion = current.slice();
  unknownVersion[0] = 3;
  const v1Labelled = current.slice();
  v1Labelled[0] = BINDING_VERSIONS.V1;
  const malformed = [
    unknownVersion,
    v1Labelled,
    current.subarray(0, current.length - 1),
    fromHex(GOLDEN.legacyBindingValue).subarray(1),
    new Uint8Array(0),
  ];
  for (const value of malformed)
    assert.throws(() => decodeBindingValue(value), isBindingError);
});

void test('a binding sequence outside u64 is rejected before signing', async () => {
  const keys = await goldenKeys();
  const outOfRange = [-1n, 1n << 64n];
  for (const sequence of outOfRange) {
    await assert.rejects(
      signNodeBinding(keys.node, {
        asset: keys.asset.address,
        owner: keys.owner.address,
        sequence,
      }),
      hasCode(IDENTITY_ERROR_CODES.INPUT_INVALID),
    );
  }
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
  const binding = await goldenBinding(keys);
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

void test('nodeId metadata prefix sits at offset 42 of an encoded metadata account, for each version', () => {
  const values = [
    { version: BINDING_VERSIONS.V2, value: fromHex(GOLDEN.bindingValue) },
    {
      version: BINDING_VERSIONS.V1,
      value: fromHex(GOLDEN.legacyBindingValue),
    },
  ];
  for (const { version, value } of values) {
    const account = concatBytes([
      ACCOUNT_DISCRIMINATORS.metadata,
      new Uint8Array(32),
      Uint8Array.of(0, 255),
      encodeString(METADATA_KEYS.nodeId),
      encodeVecU8(value),
    ]);
    const prefix = nodeIdMetadataPrefix(GOLDEN.nodeId, version);
    assert.equal(hex(account.subarray(42, 42 + prefix.length)), hex(prefix));
    assert.equal(decodeMetadataEntry(account).key, METADATA_KEYS.nodeId);
    assert.equal(
      address(decodeMetadataEntry(account).asset),
      '11111111111111111111111111111111',
    );
  }
});
