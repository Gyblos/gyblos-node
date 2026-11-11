// Composes the product seller-control, readiness, sequence and publisher components for acceptance.
// It excludes paid seller startup, facilitator, RPC and role keys; persistent state is caller-owned temp data.
import type { KeyPairSigner } from '@solana/kit';

import { DEVNET_USDC, SELLER_READINESS } from '@gyblos/config';
import { FreeSellerLedger } from '@gyblos/core/free-admission';
import { publishRecord } from '@gyblos/discovery-http';
import { singleControlOffer } from '@gyblos/node/control-offers';
import { observeControlReadiness } from '@gyblos/node/control-readiness';
import { prepareSellerControl } from '@gyblos/node/control-startup';
import { probeSellerEngine } from '@gyblos/node/engine-readiness';
import {
  OLLAMA_READINESS,
  ollamaSelection,
} from '@gyblos/node/engine-registry-ollama';
import { prepareSellerFreeExecution } from '@gyblos/node/free-execution';
import { recountedMeter } from '@gyblos/node/free-meter';
import { sellerLimits } from '@gyblos/node/node-config-limits';
import { openSellerSequence } from '@gyblos/node/public-sequence';
import { createSellerPublisher } from '@gyblos/node/publisher';
import type { SellerCatalogOffer } from '@gyblos/node/seller-offer';
import { CONTROL_METERING_MODES } from '@gyblos/protocol/constants';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import { controlDeadline } from '@gyblos/transport-iroh/control-io';

import type { AcceptanceClock } from './clock';
import type { AcceptanceEngine } from './engine';
import { assertAcceptanceActive } from './errors';
import type { AcceptanceIndex } from './index';
import type { AcceptanceWire } from './native';
import { pocPaidListing } from './paid-listing';
import type { AcceptanceWorkspace } from './workspace';

export interface AcceptanceIdentity {
  owner: KeyPairSigner;
  buyer: KeyPairSigner;
  payTo: KeyPairSigner;
  feePayer: KeyPairSigner;
  authorizer: KeyPairSigner;
}
export interface AcceptanceHostOptions {
  offer?: SellerCatalogOffer;
  tokenizer?: ChatTokenizer;
  wire: AcceptanceWire;
  identity: AcceptanceIdentity;
  clock: AcceptanceClock;
  engine: AcceptanceEngine;
  workspace: AcceptanceWorkspace;
  index: AcceptanceIndex;
  signal: AbortSignal;
}
export async function startAcceptanceHost(options: AcceptanceHostOptions) {
  const { clock, engine, identity, signal } = options;
  const wire = options.wire;
  let observation: ReturnType<typeof observeControlReadiness> | undefined;
  let publication: ReturnType<typeof createSellerPublisher> | undefined;
  let detach = () => {};
  try {
    assertAcceptanceActive(signal);
    const initial = await controlDeadline(
      (deadline) =>
        probeSellerEngine(engine.engine, deadline, {
          policy: OLLAMA_READINESS,
          snapshot: engine.snapshot,
          now: clock.now,
        }),
      SELLER_READINESS.timeoutMs,
      () => {},
      signal,
    );
    observation = observeControlReadiness(
      engine.engine,
      initial.offerExpiresAt,
      clock.now,
      {
        model: initial.model,
        check: (deadline) =>
          probeSellerEngine(
            engine.engine,
            AbortSignal.any([deadline, signal]),
            {
              policy: OLLAMA_READINESS,
              snapshot: engine.snapshot,
              now: clock.now,
            },
          ),
      },
    );
    const current = observation;
    const abort = () => {
      // stop() only invalidates state/timers synchronously; it performs no I/O and never rejects.
      void current.stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    detach = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
    assertAcceptanceActive(signal);
    const sequence = await openSellerSequence({
      environment: options.workspace.environment,
      nodeId: wire.nodeId,
      initialFloor: 1,
    });
    // Paid acceptance still quotes the v1 PoC listing, which the daemon no longer serves.
    const offer = options.offer ?? pocPaidListing();
    const control = await prepareSellerControl({
      offers: singleControlOffer({
        offer,
        selection: ollamaSelection(offer.modelId),
        meteringMode: CONTROL_METERING_MODES.RECOUNTED,
        model: initial.model,
        capabilities: engine.engine.capabilities(),
        readiness: current.readiness,
      }),
      owner: identity.owner,
      nodeId: wire.nodeId,
      nodeSigner: wire.nodeSigner,
      mint: DEVNET_USDC,
      payTo: identity.payTo.address,
      feePayer: identity.feePayer.address,
      authorizer: identity.authorizer.address,
      endpoint: { relayUrl: null, directAddresses: wire.directAddresses },
      relayOnly: false,
      sequence,
      now: clock.now,
      // The v1 PoC terms carry no protocol fee.
      protocolFeeBps: 0,
    });
    const sent: SignedPublicV2[] = [];
    publication = createSellerPublisher({
      records: control.records,
      now: clock.now,
      canPublish: () => {
        const state = current.readiness();
        return (
          !state.busy &&
          state.observedAt <= clock.now() &&
          state.validUntil > clock.now()
        );
      },
      publish: async (record, deadline) => {
        await publishRecord({
          baseUrl: options.index.baseUrl,
          record,
          signal: deadline,
          fetch: options.index.fetch,
        });
        sent.push(record);
      },
    });
    const publisher = publication;
    const freeExecution = options.tokenizer
      ? prepareSellerFreeExecution({
          owner: identity.owner.address,
          nodeId: wire.nodeId,
          offer,
          catalog: control.records.current(),
          model: initial.model,
          capabilities: engine.engine.capabilities(),
          engine: current.engine,
          meter: recountedMeter(options.tokenizer),
          readiness: current.readiness,
          now: clock.now,
          ledger: new FreeSellerLedger(
            clock.now(),
            sellerLimits().maxFreeBuyers,
          ),
        })
      : undefined;
    wire.start(control.service, freeExecution);
    return {
      wire,
      observation: current,
      publisher,
      control,
      sent,
      async close() {
        detach();
        engine.release();
        await current.stop();
        try {
          await publisher.stop();
        } finally {
          await wire.close();
        }
      },
    };
  } catch (error) {
    detach();
    engine.release();
    await observation?.stop();
    try {
      await publication?.stop();
    } finally {
      await wire.close();
    }
    throw error;
  }
}
export type AcceptanceHost = Awaited<ReturnType<typeof startAcceptanceHost>>;
