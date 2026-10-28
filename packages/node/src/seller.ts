// Starts the P2P seller: local Ollama and facilitator, engine warmup, the inference seller on loopback, a
// signed offer and the Iroh bridge; tears everything down in reverse order on failure.
import { once } from 'node:events';
import { resolve } from 'node:path';

import { EndpointTicket } from '@number0/iroh';

import {
  CLEANUP,
  DEVNET,
  DIAGNOSTICS,
  homeLayout,
  HOSTS,
  INFERENCE_REQUEST_LIMITS,
  LOCALHOST,
  MAX_ATOMIC,
  PORTS,
  ROLE_FILES,
  ROUTES,
  SELLER_DISCOVERY,
  TRANSPORT_LIMITS,
  TRANSPORT_TIMEOUTS,
} from '@gyblos/config';
import { PRICES } from '@gyblos/core/constants';
import { publishRecord } from '@gyblos/discovery-http';
import {
  GENERATION,
  READINESS_GENERATION,
} from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { inferenceSnapshot } from '@gyblos/payments-x402/accounting/chain';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import {
  GYBLOS_ALPN,
  OFFER_PRICING_KINDS,
  OFFER_SCHEMA_VERSION,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
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

import { modelTokenizer } from './artifacts';
import { SELLER_PUBLIC_RECORDS } from './constants';
import { observeControlReadiness } from './control-readiness';
import { prepareSellerControl } from './control-startup';
import {
  assertReadinessCurrent,
  prepareSellerEngine,
  probeSellerEngine,
} from './engine-readiness';
import { assertOllamaModelsHome, assertRoleHome } from './home';
import { createInferenceSeller } from './http/inference';
import { signInferenceOffer } from './offers';
import { openSellerSequence } from './public-sequence';
import { createSellerPublisher } from './publisher';
import { loadRole, nodeSecret, rolePath, roleSigner } from './roles';
import { loadSellerSettings } from './seller-settings';
import { serveSellerTransport } from './seller-transport';

interface Trace {
  requestId: string;
  channelId: string;
  preInferenceObservedAt: string;
  during: Awaited<ReturnType<typeof inferenceSnapshot>>;
}

export async function startSeller() {
  const startedAt = Date.now();
  const disposers: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const dispose of disposers.splice(0).reverse())
      await dispose().catch(() => {});
  };
  try {
    const stage = (phase: string) =>
      saveJson(rolePath(P2P_ROLES.SELLER, ROLE_FILES.status), {
        status: 'starting',
        phase,
        runId: process.env.GYBLOS_P2P_RUN_ID,
      });
    // Before the first status write, which would create the new role directory.
    await assertRoleHome(P2P_ROLES.SELLER);
    await stage('configuration');
    const config = await loadRole(P2P_ROLES.SELLER);
    if (config.role !== P2P_ROLES.SELLER)
      throw new Error('Seller role required.');
    const settings = await loadSellerSettings(process.env, undefined, {
      freeExecution: true,
    });
    const isFree = settings.offer.kind === OFFER_PRICING_KINDS.FREE;
    const publicationConfig = settings.publication;
    const publicSequence = await openSellerSequence({
      environment: process.env,
      nodeId: config.nodeId,
    });
    if (!isFree) {
      await stage('devnet-program');
      await assertProgram(config.rpcUrl);
    }
    await assertPortFree(`${HOSTS.ollama}${ROUTES.ollamaVersion}`);
    if (!isFree) await assertPortFree(`${HOSTS.facilitator}${ROUTES.health}`);
    await stage('ollama-startup');
    await assertOllamaModelsHome();
    const child = spawnChild('ollama', ['serve'], {
      env: {
        PATH: process.env.PATH,
        HOME: resolve(homeLayout(process.env).roles.seller),
        TMPDIR: process.env.TMPDIR,
        OLLAMA_HOST: HOSTS.ollamaBind,
        OLLAMA_MODELS: resolve(homeLayout(process.env).artifacts.ollamaModels),
        OLLAMA_NO_CLOUD: '1',
        OLLAMA_DEBUG: '0',
        OLLAMA_CONTEXT_LENGTH: String(GENERATION.numCtx),
        OLLAMA_NUM_PARALLEL: String(READINESS_GENERATION.parallel),
        OLLAMA_MAX_LOADED_MODELS: String(READINESS_GENERATION.loadedModels),
        OLLAMA_MAX_QUEUE: String(TRANSPORT_LIMITS.maxConcurrent),
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
        saveJson(
          rolePath(P2P_ROLES.SELLER, DIAGNOSTICS.readinessFilename),
          record,
        ),
    });
    await stage('role-signers');
    const owner = await roleSigner(P2P_ROLES.SELLER, 'owner');
    const authorizer = isFree
      ? owner
      : await roleSigner(P2P_ROLES.SELLER, 'authorizer');
    const facilitator = isFree
      ? owner
      : await roleSigner(P2P_ROLES.SELLER, 'facilitator');
    if (!isFree) {
      const diagnosticLog = await createPrivateLog(
        rolePath(P2P_ROLES.SELLER, ROLE_FILES.facilitatorDiagnostics),
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
        await new Promise<void>((done) =>
          facilitatorServer.close(() => done()),
        );
      });
      host.cleanup.start({
        intervalSecs: CLEANUP.intervalSeconds,
        abandonGraceSecs: CLEANUP.abandonGraceSeconds,
      });
    }
    let traces: Trace[] = [];
    if (!isFree) {
      try {
        traces = await loadJson<Trace[]>(
          rolePath(P2P_ROLES.SELLER, ROLE_FILES.traces),
        );
        if (!Array.isArray(traces)) throw new Error('Invalid trace history.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await stage('seller-middleware');
    const controlReadiness = observeControlReadiness(
      engine,
      offerExpiresAt,
      Date.now,
      {
        model,
        check: (signal) =>
          probeSellerEngine(engine, signal, { snapshot: memorySnapshot }),
      },
    );
    const tokenizer = await modelTokenizer();
    if (!isFree) {
      const seller = await createInferenceSeller({
        rpcUrl: config.rpcUrl,
        facilitatorUrl: HOSTS.facilitator,
        feePayer: facilitator.address,
        engine: controlReadiness.engine,
        mint: config.mint,
        payTo: config.payTo,
        authorizer,
        tokenizer,
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
          await saveJson(rolePath(P2P_ROLES.SELLER, ROLE_FILES.traces), traces);
        },
      });
      const sellerServer = seller.app.listen(PORTS.seller, LOCALHOST);
      await once(sellerServer, 'listening');
      disposers.push(async () => {
        sellerServer.closeAllConnections();
        await new Promise<void>((done) => sellerServer.close(() => done()));
      });
    }
    await stage('iroh-endpoint');
    const { relayOnly } = settings;
    const endpoint = await bindEndpoint(await nodeSecret(P2P_ROLES.SELLER), {
      relayOnly,
      control: true,
      freeExecution: isFree,
      http: !isFree,
      bindAddress: settings.irohBind,
      externalAddress: settings.irohExternalAddress,
      relayEnvironment: settings.relayEnvironment,
    });
    const endpointDisposeIndex = disposers.length;
    disposers.push(() => endpoint.close());
    if (endpoint.id().toString() !== config.nodeId)
      throw new Error('Node key changed unexpectedly.');
    await withDeadline(endpoint.online(), TRANSPORT_TIMEOUTS.connectMs, () => {
      void endpoint.close();
    });
    const endpointAddress = endpoint.addr();
    assertMemoryHeadroom(await memorySnapshot());
    const now = Date.now();
    assertReadinessCurrent(offerExpiresAt, now);
    const endpointInfo = {
      relayUrl: endpointAddress.relayUrl(),
      directAddresses: relayOnly ? [] : endpointAddress.directAddresses(),
    };
    if (!isFree) {
      const signed = await signInferenceOffer(
        {
          schemaVersion: OFFER_SCHEMA_VERSION,
          protocol: GYBLOS_ALPN,
          owner: owner.address,
          nodeId: config.nodeId,
          endpoint: endpointInfo,
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
      await saveJson(rolePath(P2P_ROLES.SELLER, ROLE_FILES.offer), signed);
    }
    const control = await prepareSellerControl({
      owner,
      sequence: publicSequence,
      catalogMs: publicationConfig
        ? SELLER_PUBLIC_RECORDS.catalogMs
        : undefined,
      nodeId: config.nodeId,
      nodeSigner: async (bytes) =>
        Uint8Array.from(
          endpoint
            .secretKey()
            .sign([...bytes])
            .toBytes(),
        ),
      mint: config.mint,
      payTo: config.payTo,
      feePayer: facilitator.address,
      authorizer: authorizer.address,
      endpoint: endpointInfo,
      relayOnly,
      model,
      capabilities: engine.capabilities(),
      validUntil: offerExpiresAt,
      readiness: controlReadiness.readiness,
      offer: settings.offer,
    });
    disposers.push(async () => {
      await control.records.withdraw();
    });
    const bridge = serveSellerTransport(endpoint, control, {
      owner: owner.address,
      nodeId: config.nodeId,
      model,
      engine: controlReadiness.engine,
      tokenizer,
      readiness: controlReadiness.readiness,
      startedAt,
      relayOnly,
      limits: settings.limits,
    });
    disposers[endpointDisposeIndex] = () => bridge.close();
    const publication = publicationConfig
      ? createSellerPublisher({
          records: control.records,
          canPublish: () => {
            const observed = controlReadiness.readiness();
            return (
              !observed.busy &&
              observed.observedAt <= Date.now() &&
              observed.validUntil > Date.now()
            );
          },
          publish: async (record, signal) => {
            await publishRecord({
              baseUrl: publicationConfig.baseUrl,
              record,
              signal,
              fetch: globalThis.fetch,
              timeoutMs: SELLER_DISCOVERY.requestMs,
            });
          },
        })
      : undefined;
    if (publication) {
      disposers.push(() => publication.stop());
      publication.start();
    }
    controlReadiness.start(() => control.records.refresh());
    disposers.push(() => controlReadiness.stop());
    await saveJson(rolePath(P2P_ROLES.SELLER, ROLE_FILES.status), {
      status: 'ready',
      runId: process.env.GYBLOS_P2P_RUN_ID,
      role: P2P_ROLES.SELLER,
      nodeId: config.nodeId,
      relayOnly,
      capabilities: engine.capabilities(),
      model,
      offerTicket: EndpointTicket.fromAddr(endpointAddress).toString(),
    });
    return {
      close,
      publication: publication ? () => publication.health() : undefined,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
