// Verifies the seller's declared Solana network before ledger, account or signing operations.
import {
  UPTO_SOLANA_NAMESPACE,
  UPTO_SOLANA_REFERENCE_LENGTH,
} from 'x402-upto-metered';

import { TIMEOUTS } from '@gyblos/config';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

export interface SellerGenesisRpc {
  getGenesisHash(): {
    send(config?: { abortSignal: AbortSignal }): Promise<string>;
  };
}

export async function verifySellerNetwork(
  rpc: SellerGenesisRpc,
  network: string,
) {
  const [namespace, reference, ...rest] = network.split(':');
  const signal = AbortSignal.timeout(TIMEOUTS.rpc);
  const aborted = () => new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE);
  let genesis: string;
  let onAbort = () => {};
  try {
    if (signal.aborted) throw aborted();
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => reject(aborted());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    genesis = await Promise.race([
      rpc.getGenesisHash().send({ abortSignal: signal }),
      timeout,
    ]);
  } catch {
    throw aborted();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (
    namespace !== UPTO_SOLANA_NAMESPACE ||
    reference?.length !== UPTO_SOLANA_REFERENCE_LENGTH ||
    rest.length !== 0 ||
    String(genesis).slice(0, UPTO_SOLANA_REFERENCE_LENGTH) !== reference
  )
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
}
