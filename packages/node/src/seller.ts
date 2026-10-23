// Starts the P2P seller: local Ollama and facilitator, engine warmup, the inference seller on loopback, a
// signed offer and the Iroh bridge; tears everything down in reverse order on failure.
import { once } from 'node:events';
import { resolve } from 'node:path';

import { EndpointTicket } from '@number0/iroh';

import {
  CLEANUP,
  DEVNET,
  DIAGNOSTICS,
  FACILITATOR_LOG_PATHS,
  HOSTS,
  INFERENCE_REQUEST_LIMITS,
  LOCALHOST,
  MAX_ATOMIC,
  OLLAMA_MODELS_PATH,
  P2P,
  PORTS,
  ROUTES,
} from '@gyblos/config';
import { PRICES } from '@gyblos/core/constants';
import {
  GENERATION,
  READINESS_GENERATION,
} from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { inferenceSnapshot } from '@gyblos/payments-x402/accounting/chain';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import { GYBLOS_ALPN, OFFER_SCHEMA_VERSION } from '@gyblos/protocol/constants';
import {
  assertPortFree,
  loadJson,
  saveJson,
  spawnChild,
  stopChild,
  waitReady,
} from '@gyblos/runtime';
import { assertMemoryHeadroom, memorySnapshot } from '@gyblos/runtime/memory';
import { createPrivateLog } from '@gyblos/runtime/private-log';
import { withDeadline } from '@gyblos/transport-iroh/deadline';
import { bindEndpoint } from '@gyblos/transport-iroh/endpoint';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { modelTokenizer } from './artifacts.js';
import { P2P_ROLES } from './constants.js';
import {
  assertReadinessCurrent,
  prepareSellerEngine,
} from './engine-readiness.js';
import { createInferenceSeller } from './http/inference.js';
import { signInferenceOffer } from './offers.js';
import { loadRole, nodeSecret, rolePath, roleSigner } from './roles.js';

interface Trace {
  requestId: string;
  channelId: string;
  preInferenceObservedAt: string;
  during: Awaited<ReturnType<typeof inferenceSnapshot>>;
}

export async function startSeller() {
  const disposers: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const dispose of disposers.splice(0).reverse())
      await dispose().catch(() => {});
  };
  try {
    const stage = (phase: string) =>
      saveJson(rolePath(P2P.statusFilename), {
        status: 'starting',
        phase,
        runId: process.env.GYBLOS_P2P_RUN_ID,
      });
    await stage('configuration');
    const config = await loadRole();
    if (config.role !== P2P_ROLES.SELLER)
      throw new Error('Seller role required.');
    await stage('devnet-program');
    await assertProgram(config.rpcUrl);
    await assertPortFree(`${HOSTS.ollama}${ROUTES.ollamaVersion}`);
    await assertPortFree(`${HOSTS.facilitator}${ROUTES.health}`);
    await stage('ollama-startup');
    const child = spawnChild('ollama', ['serve'], {
      env: {
        PATH: process.env.PATH,
        HOME: resolve(P2P.root),
        TMPDIR: process.env.TMPDIR,
        OLLAMA_HOST: HOSTS.ollamaBind,
        OLLAMA_MODELS: resolve(OLLAMA_MODELS_PATH),
        OLLAMA_NO_CLOUD: '1',
        OLLAMA_DEBUG: '0',
        OLLAMA_CONTEXT_LENGTH: String(GENERATION.numCtx),
        OLLAMA_NUM_PARALLEL: String(READINESS_GENERATION.parallel),
        OLLAMA_MAX_LOADED_MODELS: String(READINESS_GENERATION.loadedModels),
        OLLAMA_MAX_QUEUE: String(P2P.maxConcurrent),
      },
      stdio: 'ignore',
    });
    disposers.push(() => stopChild(child));
    let processError = false;
    child.once('error', () => {
      processError = true;
    });
    try {
      await waitReady(child, `${HOSTS.ollama}${ROUTES.ollamaVersion}`, {
        startupError: () => processError,
      });
    } catch (error) {
      await stopChild(child);
      throw error;
    }
    await stage('private-engine-warmup');
    const engine = createOllamaEngine(HOSTS.ollama);
    const { model, offerExpiresAt } = await prepareSellerEngine(engine, {
      snapshot: memorySnapshot,
      record: (record) =>
        saveJson(rolePath(DIAGNOSTICS.readinessFilename), record),
    });
    await stage('role-signers');
    const owner = await roleSigner('owner');
    const authorizer = await roleSigner('authorizer');
    const facilitator = await roleSigner('facilitator');
    const diagnosticLog = await createPrivateLog(
      rolePath(FACILITATOR_LOG_PATHS.roleDirectory),
    );
    disposers.push(async () => {
      await diagnosticLog.close();
    });
    const host = createFacilitator(
      facilitator,
      config.rpcUrl,
      {
        buyer: config.buyer,
        mint: config.mint,
        payTo: config.payTo,
        authorizer: authorizer.address,
      },
      undefined,
      { onDiagnostic: diagnosticLog.write },
    );
    host.app.get(ROUTES.facilitatorDiagnostics, (_request, response) => {
      response.json(diagnosticLog.health());
    });
    const facilitatorServer = host.app.listen(PORTS.facilitator, LOCALHOST);
    await once(facilitatorServer, 'listening');
    disposers.push(async () => {
      await host.cleanup.stop();
      facilitatorServer.closeAllConnections();
      await new Promise<void>((done) => facilitatorServer.close(() => done()));
    });
    host.cleanup.start({
      intervalSecs: CLEANUP.intervalSeconds,
      abandonGraceSecs: CLEANUP.abandonGraceSeconds,
    });
    let traces: Trace[] = [];
    try {
      traces = await loadJson<Trace[]>(rolePath(P2P.traceFilename));
      if (!Array.isArray(traces)) throw new Error('Invalid trace history.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await stage('seller-middleware');
    const seller = await createInferenceSeller({
      rpcUrl: config.rpcUrl,
      facilitatorUrl: HOSTS.facilitator,
      feePayer: facilitator.address,
      engine,
      mint: config.mint,
      payTo: config.payTo,
      authorizer,
      tokenizer: await modelTokenizer(),
      async beforeInference(requestId, channelId) {
        const during = await inferenceSnapshot(
          {
            rpcUrl: config.rpcUrl,
            mint: config.mint,
            addresses: { buyer: config.buyer, seller: config.payTo },
          },
          channelId,
        );
        traces.push({
          requestId,
          channelId,
          preInferenceObservedAt: new Date().toISOString(),
          during,
        });
        await saveJson(rolePath(P2P.traceFilename), traces);
      },
    });
    const sellerServer = seller.app.listen(P2P.sellerPort, LOCALHOST);
    await once(sellerServer, 'listening');
    disposers.push(async () => {
      sellerServer.closeAllConnections();
      await new Promise<void>((done) => sellerServer.close(() => done()));
    });
    await stage('iroh-endpoint');
    const relayOnly = process.env.GYBLOS_RELAY_ONLY === '1';
    const endpoint = await bindEndpoint(await nodeSecret(), {
      relayOnly,
      bindAddress: process.env.GYBLOS_IROH_BIND,
      externalAddress: process.env.GYBLOS_IROH_EXTERNAL_ADDR || undefined,
    });
    disposers.push(() => endpoint.close());
    if (endpoint.id().toString() !== config.nodeId)
      throw new Error('Node key changed unexpectedly.');
    await withDeadline(endpoint.online(), P2P.connectMs, () => {
      void endpoint.close();
    });
    const endpointAddress = endpoint.addr();
    assertMemoryHeadroom(await memorySnapshot());
    const now = Date.now();
    assertReadinessCurrent(offerExpiresAt, now);
    const signed = await signInferenceOffer(
      {
        schemaVersion: OFFER_SCHEMA_VERSION,
        protocol: GYBLOS_ALPN,
        owner: owner.address,
        nodeId: config.nodeId,
        endpoint: {
          relayUrl: endpointAddress.relayUrl(),
          directAddresses: relayOnly ? [] : endpointAddress.directAddresses(),
        },
        relayOnly,
        network: DEVNET,
        mint: config.mint,
        payTo: config.payTo,
        feePayer: facilitator.address,
        authorizer: authorizer.address,
        buyer: config.buyer,
        issuedAt: now,
        expiresAt: offerExpiresAt,
        prices: PRICES,
        maxAtomic: MAX_ATOMIC,
        maxTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens,
        model,
        capabilities: engine.capabilities(),
        meteringMode: 'recounted',
      },
      owner,
    );
    await saveJson(rolePath(P2P.offerFilename), signed);
    const bridge = serveIroh(
      endpoint,
      `http://${LOCALHOST}:${P2P.sellerPort}`,
      relayOnly,
    );
    await saveJson(rolePath(P2P.statusFilename), {
      status: 'ready',
      runId: process.env.GYBLOS_P2P_RUN_ID,
      role: P2P_ROLES.SELLER,
      nodeId: config.nodeId,
      relayOnly,
      capabilities: engine.capabilities(),
      model,
      offerTicket: EndpointTicket.fromAddr(endpointAddress).toString(),
    });
    disposers.pop();
    disposers.push(() => bridge.close());
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
