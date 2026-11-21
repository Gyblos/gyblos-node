// Enforces the seller's fee budget before SDK admission or either local signing API.
// Validation never sends transactions, replaces a pending attempt or changes a recorded obligation.
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  TRANSACTION_SIZE_LIMIT,
  type KeyPairSigner,
  type ReadonlyUint8Array,
} from '@solana/kit';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  toFacilitatorSvmSigner,
  type FacilitatorRpcClient,
} from '@x402/svm';
import {
  createUptoFacilitator,
  createUptoVerifier,
  decodeUptoPayload,
  type UptoChainStore,
  type UptoVerifier,
} from 'x402-upto-metered';

import { PAYMENT_TRANSACTION_LIMITS } from '@gyblos/config/payment-fees';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import { rateLimitedSolanaRpc } from './rpc-rate-limit';

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const LIMIT_BYTES = 5;
const PRICE_BYTES = 9;
function refused(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
}
// The SDK signs its pre-submission simulation (open + settle + distribute under the transaction maximum)
// with this all-zero blockhash (@x402/svm's SIM_PLACEHOLDER_BLOCKHASH, not exported). No recent
// blockhash or durable nonce is zero, so such a transaction can never be broadcast and its compute
// budget can cost nothing.
const SIMULATION_ONLY_BLOCKHASH = '11111111111111111111111111111111';
// allowSimulation: only when the fee payer itself signs, a simulation-only message may carry any budget;
// admission of a buyer's wire always applies the ceilings.
function feeMessage(
  bytes: ReadonlyUint8Array,
  feePayer: string,
  { allowSimulation = false } = {},
) {
  try {
    if (bytes.byteLength > TRANSACTION_SIZE_LIMIT) return refused();
    const message = getCompiledTransactionMessageDecoder().decode(bytes);
    if (
      message.staticAccounts[0] !== feePayer ||
      message.header.numSignerAccounts < 1 ||
      message.header.numSignerAccounts >
        PAYMENT_TRANSACTION_LIMITS.maxRequiredSignatures ||
      ('addressTableLookups' in message && message.addressTableLookups?.length)
    )
      return refused();
    if (allowSimulation && message.lifetimeToken === SIMULATION_ONLY_BLOCKHASH)
      return;
    let limit = false;
    let price = false;
    for (const instruction of message.instructions) {
      if (
        message.staticAccounts[instruction.programAddressIndex] !==
        COMPUTE_BUDGET_PROGRAM_ADDRESS
      )
        continue;
      if (!instruction.data) return refused();
      const data = Uint8Array.from(instruction.data);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (
        data[0] === SET_COMPUTE_UNIT_LIMIT &&
        data.length === LIMIT_BYTES &&
        !limit
      ) {
        const units = view.getUint32(1, true);
        if (!units || units > PAYMENT_TRANSACTION_LIMITS.maxComputeUnits)
          return refused();
        limit = true;
      } else if (
        data[0] === SET_COMPUTE_UNIT_PRICE &&
        data.length === PRICE_BYTES &&
        !price
      ) {
        if (
          view.getBigUint64(1, true) >
          BigInt(PAYMENT_TRANSACTION_LIMITS.maxPriorityFeeMicroLamports)
        )
          return refused();
        price = true;
      } else return refused();
    }
    if (!limit) return refused();
  } catch {
    return refused();
  }
}

export function limitedFeePayer(signer: KeyPairSigner): KeyPairSigner {
  return {
    address: signer.address,
    keyPair: signer.keyPair,
    signMessages: async (messages, options) => {
      for (const message of messages)
        feeMessage(message.content, signer.address, { allowSimulation: true });
      return signer.signMessages(messages, options);
    },
    signTransactions: async (transactions, options) => {
      for (const transaction of transactions)
        feeMessage(transaction.messageBytes, signer.address, {
          allowSimulation: true,
        });
      return signer.signTransactions(transactions, options);
    },
  };
}
export function assertFeeWire(wire: unknown, feePayer: string): void {
  try {
    if (typeof wire !== 'string' || wire.length > TRANSACTION_SIZE_LIMIT * 2)
      return refused();
    const raw = Buffer.from(wire, 'base64');
    if (raw.length > TRANSACTION_SIZE_LIMIT || raw.toString('base64') !== wire)
      return refused();
    feeMessage(getTransactionDecoder().decode(raw).messageBytes, feePayer);
  } catch {
    return refused();
  }
}
export function feeBoundedUptoVerifier(
  feePayer: string,
  verify: UptoVerifier,
): UptoVerifier {
  return async (authorization, terms) => {
    try {
      assertFeeWire(decodeUptoPayload(authorization).openTransaction, feePayer);
    } catch {
      return false;
    }
    return verify(authorization, terms);
  };
}

export function sellerUptoFeePolicy(options: {
  feePayer: KeyPairSigner;
  rpcUrl: string;
  store: UptoChainStore;
  slot: () => Promise<bigint>;
}) {
  const { feePayer, rpcUrl, store, slot } = options;
  return {
    facilitator: createUptoFacilitator(
      toFacilitatorSvmSigner(
        limitedFeePayer(feePayer),
        rateLimitedSolanaRpc(rpcUrl) as FacilitatorRpcClient,
      ),
      store,
      PAYMENT_TRANSACTION_LIMITS,
    ),
    verify: feeBoundedUptoVerifier(
      feePayer.address,
      createUptoVerifier(feePayer.address, slot, PAYMENT_TRANSACTION_LIMITS),
    ),
  };
}
