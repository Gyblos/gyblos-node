// Guided buyer configuration through public entries in fresh synthetic homes; no live service or funds.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBuyerInit } from '@gyblos/buyer/init';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { DEVNET, DEVNET_RPC_URL, DEVNET_USDC, FILE_MODES, INFERENCE_REQUEST_LIMITS, IROH_RELAYS, ROLE_FILES, rolePathIn } from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { MODEL } from '@gyblos/engine-ollama/model';
import { buildBuyerInit, buyerInitDefaults, BuyerInitError, initializeBuyer, type BuyerInitAnswers } from '@gyblos/node/buyer-init';
import { BUYER_INIT_CODES, ROLE_CONFIG_SCHEMA_VERSION } from '@gyblos/node/constants';
import { setupRole, type RoleConfig } from '@gyblos/node/roles';
import { DATA_RETENTION, MODEL_IDS, P2P_ROLES, REASONING_LEVELS } from '@gyblos/protocol/constants';

const owner = '11111111111111111111111111111111';
const sellerNodeId = 'ab'.repeat(32);
function answers(): BuyerInitAnswers {
  return { modelId: MODEL_IDS.QWEN3_0_6B, variant: '', quantization: MODEL.quantization, maxTokens: '128', maxUsdc: '0', inputUsdcPerMtok: '0', outputUsdcPerMtok: '0', sellerOwner: owner, sellerNodeId, relayUrl: IROH_RELAYS.urls[0]!, discoveryUrl: 'https://discovery.example/v1', rpcUrl: DEVNET_RPC_URL };
}
function role(): RoleConfig {
  return { schemaVersion: ROLE_CONFIG_SCHEMA_VERSION, role: P2P_ROLES.BUYER, rpcUrl: DEVNET_RPC_URL, mint: DEVNET_USDC, assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN, buyer: owner, nodeId: 'cd'.repeat(32) };
}
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'buyer-init-'));
  const environment = { GYBLOS_HOME: join(directory, 'home') };
  const path = rolePathIn(environment, P2P_ROLES.BUYER, ROLE_FILES.buyerSelection);
  return { directory, environment, path };
}

void test('guided defaults admit only free quotes and preserve current bounded model selection', () => {
  const defaults = buyerInitDefaults();
  assert.equal(defaults.modelId, MODEL_IDS.QWEN3_0_6B);
  assert.equal(defaults.quantization, MODEL.quantization);
  assert.equal(defaults.maxTokens, String(INFERENCE_REQUEST_LIMITS.maxOutputTokens));
  assert.equal(defaults.maxUsdc, '0');
  assert.equal(defaults.inputUsdcPerMtok, '0');
  assert.equal(defaults.outputUsdcPerMtok, '0');
  assert.equal(defaults.sellerOwner, '');
  assert.equal(defaults.sellerNodeId, '');
});
void test('shared plan round-trips the runtime parser with independent 8004 verification enabled', () => {
  const parsed = parseBuyerSelectionConfig(buildBuyerInit(answers()));
  assert.equal(parsed.request.maxAtomic, '0');
  assert.equal(parsed.request.reasoning, REASONING_LEVELS.OFF);
  assert.equal(parsed.request.lowestReasoning, null);
  assert.equal(parsed.request.minimumBadge, SELLER_BADGES.DECLARED_USAGE);
  assert.deepEqual(parsed.request.retention, [DATA_RETENTION.NONE]);
  assert.equal(parsed.request.network, DEVNET);
  assert.equal(parsed.request.asset, DEVNET_USDC);
  assert.deepEqual(parsed.identity, { rpcUrl: DEVNET_RPC_URL });
  assert.equal(parsed.sellers[0]?.manualTrust, false);
  assert.deepEqual(parsed.sellers[0]?.directAddresses, []);
});
void test('USDC ceilings convert exactly without making a positive budget a paid-only mode', () => {
  const plan = buildBuyerInit({ ...answers(), maxUsdc: '0.01', inputUsdcPerMtok: '0.10', outputUsdcPerMtok: '0.000001' });
  assert.equal(plan.request.maxAtomic, '10000');
  assert.deepEqual(plan.request.priceCeilings, { inputAtomicPerMtok: '100000', outputAtomicPerMtok: '1' });
  assert.equal(buildBuyerInit({ ...answers(), maxUsdc: '1' }).request.priceCeilings.inputAtomicPerMtok, '0');
});
void test('exact custom selection is preserved without aliases or silent reasoning downgrades', () => {
  const selection = buildBuyerInit({ ...answers(), modelId: 'custom/model', variant: 'revision-a', quantization: 'custom-q' }).request.selection;
  assert.deepEqual(selection, { modelId: 'custom/model', variant: 'revision-a', quantization: 'custom-q' });
});
void test('malformed identities, unknown fields and token bounds refuse static typed errors', () => {
  for (const input of [{ ...answers(), sellerNodeId: sellerNodeId.toUpperCase() }, { ...answers(), sellerOwner: 'private-invalid-value' }, { ...answers(), maxTokens: '129' }, { ...answers(), maxTokens: '01' }, { ...answers(), maxTokens: '1e2' }, { ...answers(), manualTrust: true }, { ...answers(), reasoning: REASONING_LEVELS.HIGH }]) {
    assert.throws(() => buildBuyerInit(input), (error: unknown) => error instanceof BuyerInitError && error.code === BUYER_INIT_CODES.INVALID && !error.message.includes('private-invalid-value'));
  }
});
void test('USDC precision, canonical decimal spelling and overflow are bounded before bigint conversion', () => {
  for (const value of ['0010', '-1', '1e3', '0.0000001', '18446744073710', '9'.repeat(2049)]) {
    for (const field of ['maxUsdc', 'inputUsdcPerMtok', 'outputUsdcPerMtok'])
      assert.throws(() => buildBuyerInit({ ...answers(), [field]: value }), { code: BUYER_INIT_CODES.INVALID });
  }
});
void test('configuration refuses credentialed or unsafe URLs and unconfigured relays', () => {
  for (const field of ['discoveryUrl', 'rpcUrl'])
    for (const url of ['http://remote.example/v1', 'https://user:private-token@example.test/v1', 'https://example.test/v1?key=private-token', 'https://example.test/v1#private-token'])
      assert.throws(() => buildBuyerInit({ ...answers(), [field]: url }), { code: BUYER_INIT_CODES.INVALID });
  assert.throws(() => buildBuyerInit({ ...answers(), relayUrl: 'https://unconfigured.example/' }), { code: BUYER_INIT_CODES.INVALID });
  assert.equal(buildBuyerInit({ ...answers(), rpcUrl: 'http://127.0.0.1:9', discoveryUrl: 'http://127.0.0.1:10/v1' }).identity.rpcUrl, 'http://127.0.0.1:9');
});
void test('shared initialization writes private runtime-loadable settings and preserves unrelated state', async () => {
  const fixture = await home();
  try {
    const result = await initializeBuyer(answers(), { environment: fixture.environment, prepareRole: async () => role() });
    assert.equal(result.path, fixture.path);
    assert.equal(result.buyer, owner);
    assert.equal(parseBuyerSelectionConfig(JSON.parse(await readFile(fixture.path, 'utf8'))).request.maxAtomic, '0');
    assert.equal((await stat(fixture.path)).mode & FILE_MODES.permissionMask, FILE_MODES.privateFile);
    assert.equal((await stat(join(fixture.path, '..'))).mode & FILE_MODES.permissionMask, FILE_MODES.privateDirectory);
    assert.deepEqual(await readdir(join(fixture.path, '..')), [ROLE_FILES.buyerSelection]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
void test('existing selection is refused without opening it or preparing a role', async () => {
  const fixture = await home();
  let prepares = 0;
  try {
    await mkdir(join(fixture.path, '..'), { recursive: true, mode: FILE_MODES.privateDirectory });
    await writeFile(fixture.path, 'existing synthetic config', { mode: FILE_MODES.privateFile });
    await assert.rejects(initializeBuyer(answers(), { environment: fixture.environment, prepareRole: async () => { prepares++; return role(); } }), { code: BUYER_INIT_CODES.EXISTS });
    assert.equal(prepares, 0);
    assert.equal(await readFile(fixture.path, 'utf8'), 'existing synthetic config');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
void test('a destination created during role preparation is never overwritten', async () => {
  const fixture = await home();
  try {
    await assert.rejects(initializeBuyer(answers(), { environment: fixture.environment, prepareRole: async () => { await writeFile(fixture.path, 'concurrent synthetic config', { mode: FILE_MODES.privateFile }); return role(); } }), { code: BUYER_INIT_CODES.UNAVAILABLE });
    assert.equal(await readFile(fixture.path, 'utf8'), 'concurrent synthetic config');
    assert.deepEqual(await readdir(join(fixture.path, '..')), [ROLE_FILES.buyerSelection]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
void test('concurrent initializers commit exactly once and release their setup lock', async () => {
  const fixture = await home();
  let prepares = 0;
  const options = { environment: fixture.environment, prepareRole: async () => { prepares++; return role(); } };
  try {
    const results = await Promise.allSettled([initializeBuyer(answers(), options), initializeBuyer(answers(), options)]);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(prepares, 1);
    assert.deepEqual(await readdir(join(fixture.path, '..')), [ROLE_FILES.buyerSelection]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
void test('symlinked buyer homes and existing symlink destinations fail closed', async () => {
  const fixture = await home();
  try {
    const outside = join(fixture.directory, 'outside');
    await mkdir(outside, { mode: FILE_MODES.privateDirectory });
    await mkdir(fixture.environment.GYBLOS_HOME, { mode: FILE_MODES.privateDirectory });
    await symlink(outside, join(fixture.path, '..'));
    await assert.rejects(initializeBuyer(answers(), { environment: fixture.environment, prepareRole: async () => role() }), { code: BUYER_INIT_CODES.UNAVAILABLE });
    assert.deepEqual(await readdir(outside), []);
    await rm(join(fixture.path, '..'));
    await mkdir(join(fixture.path, '..'), { mode: FILE_MODES.privateDirectory });
    const target = join(outside, 'untouched');
    await writeFile(target, 'synthetic sentinel');
    await symlink(target, fixture.path);
    await assert.rejects(initializeBuyer(answers(), { environment: fixture.environment, prepareRole: async () => role() }), { code: BUYER_INIT_CODES.EXISTS });
    assert.equal(await readFile(target, 'utf8'), 'synthetic sentinel');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
void test('invalid input creates neither home nor role and a wrong prepared role cannot save settings', async () => {
  const fixture = await home();
  let prepares = 0;
  try {
    await assert.rejects(initializeBuyer({ ...answers(), sellerNodeId: '' }, { environment: fixture.environment, prepareRole: async () => { prepares++; return role(); } }), { code: BUYER_INIT_CODES.INVALID });
    assert.equal(prepares, 0);
    await assert.rejects(stat(fixture.environment.GYBLOS_HOME), { code: 'ENOENT' });
    await assert.rejects(initializeBuyer(answers(), { environment: fixture.environment, prepareRole: async () => ({ ...role(), mint: owner }) }), { code: BUYER_INIT_CODES.UNAVAILABLE });
    await assert.rejects(stat(fixture.path), { code: 'ENOENT' });
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
void test('a real fresh role is reused on a later setup and the generated selection loads unchanged', async () => {
  const fixture = await home();
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = fixture.environment.GYBLOS_HOME;
  try {
    const prepareRole = () => setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC });
    const result = await initializeBuyer(answers(), { environment: fixture.environment, prepareRole });
    const config = await prepareRole();
    assert.equal(result.nodeId, config.nodeId);
    assert.equal(config.role, P2P_ROLES.BUYER);
    assert.equal(parseBuyerSelectionConfig(JSON.parse(await readFile(fixture.path, 'utf8'))).sellers[0]?.nodeId, sellerNodeId);
  } finally {
    if (previous === undefined) delete process.env.GYBLOS_HOME; else process.env.GYBLOS_HOME = previous;
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
void test('wizard cancellation before answers or at confirmation performs no initialization', async () => {
  for (const confirm of [undefined, 'no']) {
    let writes = 0;
    await runBuyerInit({ read: async (question) => { if (confirm === undefined) return undefined; if (question.startsWith('Seller NodeId')) return sellerNodeId; if (question.startsWith('Seller owner')) return owner; if (question.startsWith('Save')) return confirm; return ''; }, write: () => {}, initialize: async () => { writes++; } });
    assert.equal(writes, 0);
  }
});
void test('wizard confirms an explicit USDC ceiling and passes validated answers to shared initialization', async () => {
  let received: BuyerInitAnswers | undefined;
  let output = '';
  await runBuyerInit({ read: async (question) => { if (question.startsWith('Seller NodeId')) return sellerNodeId; if (question.startsWith('Seller owner')) return owner; if (question.startsWith('Maximum spend')) return '0.01'; if (question.startsWith('Save')) return 'yes'; return ''; }, write: (text) => { output += text; }, initialize: async (input) => { received = input; } });
  assert.ok(received);
  assert.equal(buildBuyerInit(received).request.maxAtomic, '10000');
  assert.match(output, /ceiling/i);
  assert.match(output, /buyer:chat/);
});
