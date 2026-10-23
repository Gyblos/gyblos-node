// Minimal Solana JSON-RPC helpers: devnet genesis and program checks, balances and confirmation polling.
import {
  COMMITMENT,
  DIAGNOSTIC_LIMITS,
  RETRIES,
  RETRY_DELAYS,
  TIMEOUTS,
} from '@gyblos/config';
import { ProtocolError as GateError } from '@gyblos/protocol/errors';

import {
  CHANNEL_PROGRAM,
  DEVNET_GENESIS,
  GATE_ERROR_CODES,
} from './constants.js';

export { ProtocolError as GateError } from '@gyblos/protocol/errors';

export async function rpc<T>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUTS.rpc),
  });
  if (!response.ok)
    throw new GateError(
      GATE_ERROR_CODES.RPC_HTTP,
      `${method}: HTTP ${response.status}`,
    );
  const body = (await response.json()) as {
    result: T;
    error?: { code: number; message: string };
  };
  if (body.error)
    throw new GateError(
      GATE_ERROR_CODES.RPC_ERROR,
      `${method}: RPC ${body.error.code} ${body.error.message.slice(0, DIAGNOSTIC_LIMITS.rpcMessageCharacters)}`,
    );
  return body.result;
}

export async function assertDevnet(url: string): Promise<void> {
  const genesis = await rpc<string>(url, 'getGenesisHash');
  if (genesis !== DEVNET_GENESIS)
    throw new GateError(
      GATE_ERROR_CODES.WRONG_CLUSTER,
      'Only Solana devnet is allowed.',
    );
}

export async function account(url: string, address: string) {
  return (
    await rpc<{
      value: null | {
        executable: boolean;
        owner: string;
        lamports: number;
        data: [string, string];
      };
    }>(url, 'getAccountInfo', [
      address,
      { encoding: 'base64', commitment: COMMITMENT },
    ])
  ).value;
}

export async function assertProgram(url: string): Promise<void> {
  await assertDevnet(url);
  const program = await account(url, CHANNEL_PROGRAM);
  if (!program?.executable)
    throw new GateError(
      GATE_ERROR_CODES.PROGRAM_UNAVAILABLE,
      'Canonical payment-channels program is not executable.',
    );
}

export async function lamports(url: string, owner: string): Promise<bigint> {
  return BigInt(
    (
      await rpc<{ value: number }>(url, 'getBalance', [
        owner,
        { commitment: COMMITMENT },
      ])
    ).value,
  );
}

export async function tokens(
  url: string,
  owner: string,
  mint: string,
): Promise<bigint> {
  const result = await rpc<{
    value: {
      account: {
        data: { parsed: { info: { tokenAmount: { amount: string } } } };
      };
    }[];
  }>(url, 'getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: COMMITMENT },
  ]);
  return result.value.reduce(
    (sum, item) =>
      sum + BigInt(item.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}

export async function confirm(
  url: string,
  signature: string,
  options: {
    read?: typeof rpc;
    failedMessage?: string;
    unknownMessage?: string;
  } = {},
): Promise<void> {
  for (let attempt = 0; attempt < RETRIES.confirmation; attempt++) {
    const result = await (options.read ?? rpc)<{
      value: (null | { err: unknown; confirmationStatus: string })[];
    }>(url, 'getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const status = result.value[0];
    if (status?.err)
      throw new GateError(
        GATE_ERROR_CODES.TRANSACTION_FAILED,
        options.failedMessage ?? `Transaction failed: ${signature}`,
      );
    if (status && [COMMITMENT, 'finalized'].includes(status.confirmationStatus))
      return;
    await new Promise((resolve) =>
      setTimeout(resolve, RETRY_DELAYS.confirmation),
    );
  }
  throw new GateError(
    GATE_ERROR_CODES.TRANSACTION_UNKNOWN,
    options.unknownMessage ??
      `Confirmation unknown; reconcile before retrying: ${signature}`,
  );
}

export { explorerUrl as explorer } from '@gyblos/config';
