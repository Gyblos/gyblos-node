// Starts the P2P seller for its offers: warmup of the seller's own engines, signed public records and the
// Iroh bridge; offers not ready at startup are warmed again in the background. Paid offers are served
// only when the caller supplies a payment server; otherwise they refuse startup. Tears everything down
// in reverse order on failure.
import { EndpointTicket } from '@number0/iroh';

import {
  DIAGNOSTICS,
  ROLE_FILES,
  SELLER_DISCOVERY,
  TRANSPORT_TIMEOUTS,
} from '@gyblos/config';
import { FreeSellerLedger } from '@gyblos/core/free-admission';
import { publishRecord } from '@gyblos/discovery-http';
import {
  CONTROL_CODES,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import { saveJson } from '@gyblos/runtime';
import { assertMemoryHeadroom, memorySnapshot } from '@gyblos/runtime/memory';
import { withDeadline } from '@gyblos/transport-iroh/deadline';
import { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import { SELLER_PUBLIC_RECORDS } from './constants';
import { prepareSellerControl } from './control-startup';
import {
  assertReadinessCurrent,
  type ReadinessRecord,
} from './engine-readiness';
import { createSellerFreeOffers } from './free-offers';
import { assertRoleHome } from './home';
import { openSellerSequence } from './public-sequence';
import { createSellerPublisher } from './publisher';
import { createSellerReceiptRuntime, openReceiptStore } from './receipts';
import {
  loadRole,
  nodeSecret,
  rolePath,
  roleSigner,
  type RoleConfig,
} from './roles';
import { SellerOfferSet } from './seller-offer-set';
import {
  liveSellerOffer,
  prepareSellerOffers,
  retrySellerOffers,
} from './seller-offers';
import {
  openSellerPaid,
  type SellerPaid,
  type SellerPayments,
} from './seller-paid';
import { loadSellerSettings, type SellerSettings } from './seller-settings';
import { serveSellerTransport } from './seller-transport';
import { createLocalTelemetry } from './telemetry-startup';

// Refresh refusals that a later observation can clear.
const TRANSIENT = new Set<string>([
  CONTROL_CODES.STALE,
  CONTROL_CODES.EXPIRED,
  CONTROL_CODES.BUSY,
  CONTROL_CODES.CANCELLED,
]);

// Private: each offer's latest warmup outcome, rewritten whole as { offers: [...] } in index order.
function readinessDiagnostics() {
  const outcomes = new Map<number, ReadinessRecord>();
  let writing = Promise.resolve();
  return async (index: number, record: ReadinessRecord) => {
    outcomes.set(index, record);
    const snapshot = {
      offers: [...outcomes]
        .sort(([left], [right]) => left - right)
        .map(([offer, outcome]) => ({ index: offer, ...outcome })),
    };
    writing = writing
      .catch(() => {})
      .then(() =>
        saveJson(
          rolePath(P2P_ROLES.SELLER, DIAGNOSTICS.readinessFilename),
          snapshot,
        ),
      );
    await writing;
  };
}

// Private status: which gyblos.toml offers are listed now, without engine URLs.
function offerStatus(settings: SellerSettings, offers: SellerOfferSet) {
  const listed = new Set(offers.listed().map((offer) => offer.index));
  return settings.offers.map(({ offer, engine }) => ({
    index: engine.index,
    modelId: offer.modelId,
    engine: engine.engine.kind,
    listed: listed.has(engine.index),
  }));
}

export async function startSeller(
  options: {
    telemetry?: TelemetrySink;
    bind?: typeof bindEndpoint;
    // Builds the payment server for paid offers from the seller's role; without it, paid offers
    // refuse startup with SELLER_PAID_EXECUTION_UNAVAILABLE.
    payments?: (role: RoleConfig) => Promise<SellerPayments>;
  } = {},
) {
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
    // Settings refuse missing offers, and paid offers unless a payment server can be built.
    const settings = await loadSellerSettings(process.env, undefined, {
      paidSelling: options.payments !== undefined,
    });
    const sellsPaid = settings.offers.some(
      ({ offer }) => offer.kind === OFFER_PRICING_KINDS.PAID,
    );
    const telemetry = createLocalTelemetry({
      enabled: settings.telemetryFile,
      environment: process.env,
      role: P2P_ROLES.SELLER,
      sink: options.telemetry,
    });
    disposers.push(telemetry.close);
    const publicationConfig = settings.publication;
    const publicSequence = await openSellerSequence({
      environment: process.env,
      nodeId: config.nodeId,
    });
    await stage('private-engine-warmup');
    // The seller runs its engines; startup only warms each at its offer URL and never starts one.
    const offerDependencies = {
      fetch: globalThis.fetch,
      environment: process.env,
      snapshot: memorySnapshot,
      record: readinessDiagnostics(),
    };
    const { ready, pending } = await prepareSellerOffers(
      settings,
      offerDependencies,
    );
    await stage('role-signers');
    // Free execution signs only with the owner key; it also fills the quote's unused payment roles.
    const owner = await roleSigner(P2P_ROLES.SELLER, 'owner');
    await stage('control-readiness');
    const offers = new SellerOfferSet();
    for (const warmed of ready)
      offers.add(await liveSellerOffer(warmed, offerDependencies));
    const { payments } = options;
    let paid: SellerPaid | undefined;
    if (sellsPaid && payments) {
      await stage('payments');
      paid = await openSellerPaid(() => payments(config), {
        owner: owner.address,
        nodeId: config.nodeId,
        startedAt,
        offers: () => offers.all(),
      });
      disposers.push(paid.close);
    }
    await stage('iroh-endpoint');
    const { relayOnly } = settings;
    const endpoint = await (options.bind ?? bindEndpoint)(
      await nodeSecret(P2P_ROLES.SELLER),
      {
        relayOnly,
        control: true,
        freeExecution: true,
        paidExecution: paid !== undefined,
        receipts: true,
        http: false,
        bindAddress: settings.irohBind,
        externalAddress: settings.irohExternalAddress,
        relayEnvironment: settings.relayEnvironment,
      },
    );
    const endpointDisposeIndex = disposers.length;
    disposers.push(() => endpoint.close());
    if (endpoint.id().toString() !== config.nodeId)
      throw new Error('Node key changed unexpectedly.');
    await withDeadline(endpoint.online(), TRANSPORT_TIMEOUTS.connectMs, () => {
      void endpoint.close();
    });
    const endpointAddress = endpoint.addr();
    if (ready.some((warmed) => warmed.prepared.readiness.localResources))
      assertMemoryHeadroom(await memorySnapshot());
    assertReadinessCurrent(offers.readiness().validUntil, Date.now());
    const endpointInfo = {
      relayUrl: endpointAddress.relayUrl(),
      directAddresses: relayOnly ? [] : endpointAddress.directAddresses(),
    };
    const nodeSigner = async (bytes: Uint8Array<ArrayBuffer>) =>
      Uint8Array.from(
        endpoint
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      );
    const receipts = createSellerReceiptRuntime({
      nodeId: config.nodeId,
      store: openReceiptStore({
        environment: process.env,
        role: P2P_ROLES.SELLER,
        nodeId: config.nodeId,
      }),
      signer: nodeSigner,
    });
    disposers.push(receipts.close);
    const control = await prepareSellerControl({
      owner,
      sequence: publicSequence,
      catalogMs: publicationConfig
        ? SELLER_PUBLIC_RECORDS.catalogMs
        : undefined,
      nodeId: config.nodeId,
      nodeSigner,
      // Quotes name the payment server's own terms when selling paid; free quotes never use them.
      mint: paid?.description.mint ?? config.mint,
      payTo: paid?.description.payTo ?? config.payTo ?? owner.address,
      feePayer: paid?.description.feePayer ?? owner.address,
      authorizer: paid?.description.authorizer ?? owner.address,
      endpoint: endpointInfo,
      relayOnly,
      offers,
    });
    disposers.push(async () => {
      await control.records.withdraw();
    });
    const bridge = serveSellerTransport(
      endpoint,
      {
        control: control.service,
        receipts: receipts.service,
        free: createSellerFreeOffers(() => offers.all(), {
          telemetry: telemetry.sink
            ? {
                sink: telemetry.sink,
                engineKind: (index) =>
                  settings.offers[index]!.engine.engine.kind,
              }
            : undefined,
          receipts: {
            publisher: receipts.publisher,
            engineKind: (index) => settings.offers[index]!.engine.engine.kind,
          },
          owner: owner.address,
          nodeId: config.nodeId,
          now: Date.now,
          ledger: new FreeSellerLedger(
            startedAt,
            settings.limits.maxFreeBuyers,
          ),
        }),
        paid: paid?.service,
      },
      { relayOnly, limits: settings.limits },
    );
    disposers[endpointDisposeIndex] = () => bridge.close();
    const publication = publicationConfig
      ? createSellerPublisher({
          records: control.records,
          canPublish: () => {
            const observed = offers.readiness();
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
    // A refresh refused by a concurrent change is retried at the next change or tick; it must not
    // invalidate the offer whose tick ran it. Any other failure still does.
    offers.start(() =>
      control.records.refresh().catch((error: unknown) => {
        if (!(error instanceof ControlError && TRANSIENT.has(error.code)))
          throw error;
      }),
    );
    disposers.push(() => offers.stop());
    const offerTicket = EndpointTicket.fromAddr(endpointAddress).toString();
    const writeReady = () =>
      saveJson(rolePath(P2P_ROLES.SELLER, ROLE_FILES.status), {
        status: 'ready',
        runId: process.env.GYBLOS_P2P_RUN_ID,
        role: P2P_ROLES.SELLER,
        nodeId: config.nodeId,
        relayOnly,
        offers: offerStatus(settings, offers),
        offerTicket,
      });
    const retry = retrySellerOffers(pending, {
      ...offerDependencies,
      add: async (live) => {
        offers.add(live);
        // The new membership is signed now rather than at the next renewal tick.
        await control.records.refresh().catch(() => {});
        await writeReady().catch(() => {});
      },
    });
    disposers.push(() => retry.stop());
    await writeReady();
    return {
      close,
      publication: publication ? () => publication.health() : undefined,
      receipts: receipts.health,
      telemetry: telemetry.health,
      payments: paid ? () => paid.health() : undefined,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
