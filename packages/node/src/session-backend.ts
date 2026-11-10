// Financial startup ports used by shared node composition; no engine, app or private payload output.
import type { BatchStoredSession } from '@gyblos/payments-upto/batch-session';
import type {
  PaymentSessionTerms,
  SessionBuyer,
  SessionSeller,
  SessionSettlement,
} from '@gyblos/protocol/payment-session';

export interface BuyerSessionBackend {
  inspect(): Promise<BatchStoredSession | undefined>;
  create(terms: PaymentSessionTerms): Promise<SessionBuyer>;
  observe(channelId: string): Promise<SessionSettlement | undefined>;
}
export interface SellerSessionBackend {
  inspect(): Promise<BatchStoredSession | undefined>;
  // Validate native buyer proof before returning a durable handle; do not submit yet.
  create(terms: PaymentSessionTerms, payload?: string): Promise<SessionSeller>;
}
