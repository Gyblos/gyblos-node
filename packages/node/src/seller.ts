// Starts the P2P seller for its free offer: local Ollama, engine warmup, signed public records and the Iroh
// bridge; tears everything down in reverse order on failure. Paid selling is off until phase 2.
import { resolve } from 'node:path';

import { EndpointTicket } from '@number0/iroh';

import {
  DIAGNOSTICS,
  homeLayout,
  HOSTS,
  ROLE_FILES,
  SELLER_DISCOVERY,
  TRANSPORT_LIMITS,
  TRANSPORT_TIMEOUTS,
} from '@gyblos/config';
import { publishRecord } from '@gyblos/discovery-http';
import {
  GENERATION,
  READINESS_GENERATION,
} from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  assertPortFree,
  saveJson,
  spawnChild,
  stopChild,
  waitReady,
} from '@gyblos/runtime';
import { assertMemoryHeadroom, memorySnapshot } from '@gyblos/runtime/memory';
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
import { openSellerSequence } from './public-sequence';
import { createSellerPublisher } from './publisher';
import { loadRole, nodeSecret, rolePath, roleSigner } from './roles';
import { SERVED_ENGINE_PROBE } from './seller-offer';
import { loadSellerSettings } from './seller-settings';
import { serveSellerTransport } from './seller-transport';

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
    // Settings refuse missing and paid offers, so the daemon only ever serves a free listing.
    const settings = await loadSellerSettings(process.env);
    const publicationConfig = settings.publication;
    const publicSequence = await openSellerSequence({
      environment: process.env,
      nodeId: config.nodeId,
    });
    await assertPortFree(SERVED_ENGINE_PROBE);
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
      await waitReady(child, SERVED_ENGINE_PROBE, {
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
    // Free execution signs only with the owner key; it also fills the quote's unused payment roles.
    const owner = await roleSigner(P2P_ROLES.SELLER, 'owner');
    await stage('control-readiness');
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
    await stage('iroh-endpoint');
    const { relayOnly } = settings;
    const endpoint = await bindEndpoint(await nodeSecret(P2P_ROLES.SELLER), {
      relayOnly,
      control: true,
      freeExecution: true,
      http: false,
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
      feePayer: owner.address,
      authorizer: owner.address,
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
