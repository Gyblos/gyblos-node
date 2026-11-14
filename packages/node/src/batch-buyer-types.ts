// Buyer host dependencies: verified selection, independent recount and finalized-chain observation.
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import type {
  PaymentSessionTerms,
  SessionBuyer,
  SessionSettlement,
} from '@gyblos/protocol/payment-session';
import type {
  BatchClientOptions,
  BatchDestination,
  BatchEndpoint,
} from '@gyblos/transport-iroh/batch-client';

export interface BuyerBatchSessionOptions<Remote extends BatchDestination> {
  buyer: SessionBuyer;
  terms: Readonly<PaymentSessionTerms>;
  endpoint: BatchEndpoint<Remote>;
  destination: Remote;
  meter: ChatTokenizer;
  now: () => number;
  transport?: BatchClientOptions;
  // Fail closed on prior unresolved payments; the active authorized session is tracked by its own journal.
  unresolved: () => Promise<boolean>;
  // Existing discovery/catalog/request/budget and independent 8004/manual-override verification.
  verify: (quote: SignedOfferV2, signal: AbortSignal) => Promise<void>;
  // Must prove finalized transaction and amounts independently, never from the seller's reply alone.
  observe: (channelId: string) => Promise<SessionSettlement | undefined>;
}

export interface BuyerBatchContext<Remote extends BatchDestination> {
  blockMode: boolean;
  options: BuyerBatchSessionOptions<Remote>;
  terms: Readonly<PaymentSessionTerms>;
  client: ReturnType<
    typeof import('@gyblos/transport-iroh/batch-client').createBatchChannelClient<Remote>
  >;
  active: boolean;
  lifetime: AbortController;
  rpc: (
    method: import('@gyblos/protocol/batch-channel').BatchMethod,
    params: unknown,
    signal?: AbortSignal,
    onDelta?: (text: string) => Promise<void>,
    blocks?: import('@gyblos/transport-iroh/batch-server').BatchBlockClient,
  ) => Promise<import('@gyblos/protocol/batch-channel').BatchChannelResult>;
  approve: (
    bill: import('@gyblos/protocol/payment-session').SessionBill,
    voucher: import('@gyblos/protocol/payment-session').SessionVoucher,
    signal: AbortSignal,
  ) => Promise<void>;
}
