import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CHALLENGE_SET } from '@gyblos/model-verifier/challenge-set';
import { MODEL_VERIFIER } from '@gyblos/model-verifier/constants';
import { main } from '@gyblos/model-verifier/main';
import { referenceTag } from '@gyblos/model-verifier/reference';
import { createSellerControlService } from '@gyblos/node/control';
import { sellerLimits } from '@gyblos/node/node-config-limits';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import {
  CONTROL_ALPN,
  CONTROL_CODES,
  CONTROL_METHODS,
  CONTROL_VERSION,
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import { parseControlQuery } from '@gyblos/protocol/control-requests';
import {
  freeExecutionDigest,
  parseFreeExecutionRequest,
} from '@gyblos/protocol/free-execution';
import { verifyModelVerification } from '@gyblos/protocol/model-verification';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture';
import { endpoint } from './support/native-fixture';
import {
  NATIVE_CAPABILITY,
  NATIVE_TEST_OPTIONS,
} from './support/native-runtime';

async function syntheticSeller() {
  const fixture = await controlFixture(true);
  const transport = await endpoint(undefined, [
    CONTROL_ALPN,
    FREE_EXECUTION.alpn,
  ]);
  const now = Date.now();
  const target = {
    owner: fixture.catalog.owner,
    nodeId: transport.id().toString(),
    relayUrl: null,
    directAddresses: transport.addr().directAddresses(),
  };
  const nodeSigner = async (bytes: Uint8Array<ArrayBuffer>) =>
    Uint8Array.from(
      transport
        .secretKey()
        .sign([...bytes])
        .toBytes(),
    );
  fixture.setNow(now);
  fixture.setReadiness({ observedAt: now, validUntil: now + 60_000 });
  try {
    const catalog = await signPublicV2(
      {
        ...fixture.catalog,
        nodeId: target.nodeId,
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      nodeSigner,
    );
    let tick = 0;
    const control = createSellerControlService({
      context: {
        ...fixture.context,
        catalog,
        nodeId: target.nodeId,
        endpoint: {
          relayUrl: target.relayUrl,
          directAddresses: target.directAddresses,
        },
        relayOnly: false,
      },
      ownerSigner: fixture.ownerSigner,
      nodeSigner,
      monotonic: () => (tick += 1000),
    });
    let quotes = 0;
    let executions = 0;
    const server = serveSellerTransport(
      transport,
      {
        control: {
          ...control,
          async respond(value, peer, signal) {
            const query = parseControlQuery(value);
            if (query.method === CONTROL_METHODS.OFFER && ++quotes === 1)
              return {
                version: CONTROL_VERSION,
                requestId: query.requestId,
                error: { code: CONTROL_CODES.BUSY },
              };
            return control.respond(value, peer, signal);
          },
        },
        free: {
          async respond(value) {
            const request = parseFreeExecutionRequest(value);
            const reply = {
              version: FREE_EXECUTION.version,
              requestId: request.requestId,
              requestDigest: await freeExecutionDigest(request),
            };
            if (++executions === 1)
              return { ...reply, error: { code: FREE_EXECUTION_CODES.BUSY } };
            return {
              ...reply,
              result: {
                text: executions === 2 ? '' : 'Answer: word word word.',
                finishReason: ENGINE_DONE_REASONS.STOP,
                usage: {
                  inputTokens: 10,
                  outputTokens: executions === 2 ? 0 : 6,
                },
              },
            };
          },
        },
      },
      { relayOnly: false, limits: sellerLimits() },
    );
    return { target, server, modelId: fixture.catalog.models[0]!.modelId };
  } catch (error) {
    await transport.close();
    throw error;
  }
}

void test(
  'verify writes a numbered outcome for every challenge to evidence.json',
  NATIVE_TEST_OPTIONS,
  async (t) => {
    assert.ok(NATIVE_CAPABILITY.sdk);
    const { EndpointBuilder } = NATIVE_CAPABILITY.sdk;
    t.mock.method(
      EndpointBuilder.prototype,
      'applyN0',
      EndpointBuilder.prototype.applyMinimal,
    );
    const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-evidence-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const { target, server, modelId } = await syntheticSeller();
    t.after(() => server.close());
    t.mock.property(process, 'env', {
      ...process.env,
      GYBLOS_HOME: home,
      GYBLOS_RELAYS: 'https://127.0.0.1:1/',
      GYBLOS_RELAY_TOKEN: '',
    });
    t.mock.method(globalThis, 'fetch', async (url: URL) =>
      url.pathname === '/api/tags'
        ? Response.json({
            models: [
              {
                name: referenceTag(modelId),
                digest: 'ab'.repeat(32),
              },
            ],
          })
        : Response.json({
            logprobs: [{ top_logprobs: [{ token: ' w', logprob: -0.1 }] }],
          }),
    );
    const sellerFile = join(home, 'seller.json');
    const out = join(home, 'result');
    await writeFile(sellerFile, JSON.stringify(target));
    assert.equal(
      await main([
        'verify',
        '--seller',
        sellerFile,
        '--model',
        modelId,
        '--out',
        out,
      ]),
      0,
    );

    const artifact: unknown = JSON.parse(
      await readFile(join(out, MODEL_VERIFIER.evidenceFile), 'utf8'),
    );
    assert.ok(artifact && typeof artifact === 'object');
    assert.ok('answers' in artifact && Array.isArray(artifact.answers));
    assert.ok('unscored' in artifact && Array.isArray(artifact.unscored));
    assert.deepEqual(artifact.unscored.slice(0, 2), [
      { challenge: 1, phase: 'quote', code: CONTROL_CODES.BUSY },
      { challenge: 2, phase: 'execution', code: FREE_EXECUTION_CODES.BUSY },
    ]);
    assert.equal(artifact.unscored.length, 3);
    assert.equal(artifact.unscored[2]?.phase, 'scoring');
    assert.equal(artifact.unscored[2]?.code, 'EMPTY_ANSWER');
    assert.deepEqual(
      [...artifact.unscored, ...artifact.answers].map(
        (entry) => entry.challenge,
      ),
      CHALLENGE_SET.prompts.map((_, index) => index + 1),
    );
    const signed: unknown = JSON.parse(
      await readFile(join(out, MODEL_VERIFIER.resultFile), 'utf8'),
    );
    const { result } = await verifyModelVerification(signed);
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.evidence.answers, CHALLENGE_SET.prompts.length - 3);
  },
);
