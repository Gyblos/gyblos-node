import { COMMITMENT } from '@gyblos/config';
import {
  CHANNEL_PROGRAM,
  DEVNET_GENESIS,
} from '@gyblos/payments-x402/constants';

export class GateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function rpc<T>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new GateError('RPC_HTTP', `${method}: HTTP ${response.status}`);
  const body = (await response.json()) as {
    result: T;
    error?: { code: number; message: string };
  };
  if (body.error)
    throw new GateError(
      'RPC_ERROR',
      `${method}: RPC ${body.error.code} ${body.error.message.slice(0, 180)}`,
    );
  return body.result;
}

export async function assertDevnet(url: string): Promise<void> {
  const genesis = await rpc<string>(url, 'getGenesisHash');
  if (genesis !== DEVNET_GENESIS)
    throw new GateError('WRONG_CLUSTER', 'Only Solana devnet is allowed.');
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
      'PROGRAM_UNAVAILABLE',
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
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await (options.read ?? rpc)<{
      value: (null | { err: unknown; confirmationStatus: string })[];
    }>(url, 'getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const status = result.value[0];
    if (status?.err)
      throw new GateError(
        'TRANSACTION_FAILED',
        options.failedMessage ?? `Transaction failed: ${signature}`,
      );
    if (status && [COMMITMENT, 'finalized'].includes(status.confirmationStatus))
      return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new GateError(
    'TRANSACTION_UNKNOWN',
    options.unknownMessage ??
      `Confirmation unknown; reconcile before retrying: ${signature}`,
  );
}

export const explorer = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
