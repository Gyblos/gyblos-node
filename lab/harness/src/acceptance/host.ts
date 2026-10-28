// Composes the product seller-control, readiness, sequence and publisher components for acceptance.
// It excludes paid seller startup, facilitator, RPC and role keys; persistent state is caller-owned temp data.
import type { KeyPairSigner } from '@solana/kit';

import { DEVNET_USDC, SELLER_READINESS } from '@gyblos/config';
import { publishRecord } from '@gyblos/discovery-http';
import { observeControlReadiness } from '@gyblos/node/control-readiness';
import { prepareSellerControl } from '@gyblos/node/control-startup';
import { probeSellerEngine } from '@gyblos/node/engine-readiness';
import { prepareSellerFreeExecution } from '@gyblos/node/free-execution';
import { sellerLimits } from '@gyblos/node/node-config-limits';
import { openSellerSequence } from '@gyblos/node/public-sequence';
import { createSellerPublisher } from '@gyblos/node/publisher';
import {
  pocPaidListing,
  type SellerCatalogOffer,
} from '@gyblos/node/seller-offer';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import { controlDeadline } from '@gyblos/transport-iroh/control-io';

import type { AcceptanceClock } from './clock';
import type { AcceptanceEngine } from './engine';
import { assertAcceptanceActive } from './errors';
import type { AcceptanceIndex } from './index';
import type { AcceptanceWire } from './native';
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
  tokenizer?: RecountTokenizer;
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
    const control = await prepareSellerControl({
      // Paid acceptance still quotes the v1 PoC listing, which the daemon no longer serves.
      offer: options.offer ?? pocPaidListing(),
      owner: identity.owner,
      nodeId: wire.nodeId,
      nodeSigner: wire.nodeSigner,
      mint: DEVNET_USDC,
      payTo: identity.payTo.address,
      feePayer: identity.feePayer.address,
      authorizer: identity.authorizer.address,
      endpoint: { relayUrl: null, directAddresses: wire.directAddresses },
      relayOnly: false,
      model: initial.model,
      capabilities: engine.engine.capabilities(),
      validUntil: initial.offerExpiresAt,
      readiness: current.readiness,
      sequence,
      now: clock.now,
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
          offer: control.offer,
          catalog: control.records.current(),
          model: initial.model,
          capabilities: engine.engine.capabilities(),
          engine: current.engine,
          tokenizer: options.tokenizer,
          readiness: current.readiness,
          now: clock.now,
          startedAt: clock.now(),
          maxFreeBuyers: sellerLimits().maxFreeBuyers,
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
