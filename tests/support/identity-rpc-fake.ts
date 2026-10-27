// Owns a loopback JSON-RPC double for identity reads and registration sizing over synthetic accounts.
// Binds 127.0.0.1 on an ephemeral port; no network, validator, funded wallets or real keys.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createSolanaRpc,
  getBase58Encoder,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { DEVNET_GENESIS, LOCALHOST } from '@gyblos/config';

import type { SyntheticChain } from './identity-accounts.js';

const BASE58 = getBase58Encoder();
const SLOT = 100;
const BLOCK_TIME = 1_800_000_000;
const BLOCKHASH = '11111111111111111111111111111111';
// JSON-RPC "internal error": what an overloaded or failing RPC node answers.
const RPC_ERROR_CODE = -32603;
const UNITS_CONSUMED = 150_000;
const SYSTEM_OWNER = '11111111111111111111111111111111';

// Registration sizing knobs: what the owner holds before and after the simulated probe run, and an
// optional program error returned by every simulation after the first (the final-message check).
export interface SimulatedSpend {
  ownerBalance: number;
  ownerAfterProbe: number;
  fee: number | null;
  laterSimulationErr?: string;
}

export interface FakeRpcState {
  chain: SyntheticChain;
  // getMultipleAccounts requests touching any of these fail like an RPC outage.
  failingAddresses: Set<string>;
  spend: SimulatedSpend;
  // JSON-RPC method names in arrival order, so tests can count round trips.
  calls: string[];
  configs: { method: string; params: unknown[] }[];
  genesisHash: string;
  failingMethods: Set<string>;
  batchValue?: unknown;
  programValue?: unknown;
}

export interface FakeRpc {
  url: string;
  rpc: Rpc<SolanaRpcApi>;
  state: FakeRpcState;
  close(): Promise<void>;
}

interface JsonRpcCall {
  id: unknown;
  method: string;
  params: unknown[];
}

function asCall(body: unknown): JsonRpcCall {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('method' in body) ||
    typeof body.method !== 'string' ||
    !('params' in body)
  )
    throw new Error('fake rpc: not a JSON-RPC call');
  const params = Array.isArray(body.params) ? body.params : [];
  return { id: 'id' in body ? body.id : null, method: body.method, params };
}

function accountJson(chain: SyntheticChain, key: string) {
  const account = [...chain].find(([address]) => address === key)?.[1];
  if (account === undefined) return null;
  return {
    data: [Buffer.from(account.data).toString('base64'), 'base64'],
    executable: false,
    lamports: 1_000_000,
    owner: account.owner,
    rentEpoch: 0,
    space: account.data.length,
  };
}

interface Memcmp {
  offset: number;
  bytes: Uint8Array;
}

function memcmpFilters(config: unknown): Memcmp[] {
  if (typeof config !== 'object' || config === null || !('filters' in config))
    return [];
  const filters = Array.isArray(config.filters) ? config.filters : [];
  return filters.flatMap((filter: unknown) => {
    if (typeof filter !== 'object' || filter === null || !('memcmp' in filter))
      return [];
    const { memcmp } = filter;
    if (
      typeof memcmp !== 'object' ||
      memcmp === null ||
      !('offset' in memcmp) ||
      !('bytes' in memcmp) ||
      typeof memcmp.offset !== 'number' ||
      typeof memcmp.bytes !== 'string'
    )
      return [];
    return [
      {
        offset: memcmp.offset,
        bytes: new Uint8Array(BASE58.encode(memcmp.bytes)),
      },
    ];
  });
}

function matches(data: Uint8Array, filter: Memcmp): boolean {
  const window = data.subarray(
    filter.offset,
    filter.offset + filter.bytes.length,
  );
  return (
    window.length === filter.bytes.length &&
    window.every((byte, index) => byte === filter.bytes[index])
  );
}

function programAccounts(state: FakeRpcState, params: unknown[]) {
  const filters = memcmpFilters(params[1]);
  return [...state.chain]
    .filter(
      ([, account]) =>
        account.owner === params[0] &&
        filters.every((filter) => matches(account.data, filter)),
    )
    .map(([pubkey]) => ({ pubkey, account: accountJson(state.chain, pubkey) }));
}

function multipleAccounts(state: FakeRpcState, params: unknown[]) {
  const keys = Array.isArray(params[0]) ? params[0].map(String) : [];
  if (keys.some((key) => state.failingAddresses.has(key)))
    return { error: { code: RPC_ERROR_CODE, message: 'synthetic outage' } };
  return {
    result: {
      context: { slot: SLOT },
      value: Object.hasOwn(state, 'batchValue')
        ? state.batchValue
        : keys.map((key) => accountJson(state.chain, key)),
    },
  };
}

function simulation(state: FakeRpcState) {
  const simulations = state.calls.filter(
    (method) => method === 'simulateTransaction',
  ).length;
  return {
    context: { slot: SLOT },
    value: {
      err: simulations > 1 ? (state.spend.laterSimulationErr ?? null) : null,
      logs: [],
      accounts: [
        {
          data: ['', 'base64'],
          executable: false,
          lamports: state.spend.ownerAfterProbe,
          owner: SYSTEM_OWNER,
          rentEpoch: 0,
          space: 0,
        },
      ],
      unitsConsumed: UNITS_CONSUMED,
      returnData: null,
    },
  };
}

function respond(state: FakeRpcState, call: JsonRpcCall): object {
  const context = { slot: SLOT };
  state.calls.push(call.method);
  state.configs.push({ method: call.method, params: call.params });
  if (state.failingMethods.has(call.method))
    return { error: { code: RPC_ERROR_CODE, message: 'synthetic outage' } };
  switch (call.method) {
    case 'getGenesisHash':
      return { result: state.genesisHash };
    case 'getMultipleAccounts':
      return multipleAccounts(state, call.params);
    case 'getProgramAccounts':
      return {
        result: Object.hasOwn(state, 'programValue')
          ? state.programValue
          : programAccounts(state, call.params),
      };
    case 'getSlot':
      return { result: SLOT };
    case 'getBlockTime':
      return { result: BLOCK_TIME };
    case 'getLatestBlockhash':
      return {
        result: {
          context,
          value: { blockhash: BLOCKHASH, lastValidBlockHeight: SLOT },
        },
      };
    case 'getBalance':
      return { result: { context, value: state.spend.ownerBalance } };
    case 'simulateTransaction':
      return { result: simulation(state) };
    case 'getFeeForMessage':
      return { result: { context, value: state.spend.fee } };
    default:
      return { error: { code: RPC_ERROR_CODE, message: call.method } };
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serve(state: FakeRpcState): Server {
  return createServer((request, response) => {
    readBody(request)
      .then((body) => {
        const call = asCall(body);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: call.id,
            ...respond(state, call),
          }),
        );
      })
      .catch((error: unknown) => {
        response.statusCode = 500;
        response.end(String(error));
      });
  });
}

export async function startFakeRpc(
  chain: SyntheticChain,
  spend: SimulatedSpend = { ownerBalance: 0, ownerAfterProbe: 0, fee: 0 },
): Promise<FakeRpc> {
  const state: FakeRpcState = {
    chain,
    failingAddresses: new Set(),
    spend,
    calls: [],
    configs: [],
    genesisHash: DEVNET_GENESIS,
    failingMethods: new Set(),
  };
  const server = serve(state);
  server.listen(0, LOCALHOST);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${LOCALHOST}:${port}`,
    rpc: createSolanaRpc(`http://${LOCALHOST}:${port}`),
    state,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}
