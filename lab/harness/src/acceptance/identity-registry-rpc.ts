// Validates bounded synthetic JSON-RPC reads and faithfully applies memcmp to ephemeral account bytes.
// Unknown methods return static errors; no transaction or external provider is reachable.
import type { IncomingMessage } from 'node:http';

import { getBase58Encoder } from '@solana/kit';

import { DEVNET_GENESIS } from '@gyblos/config';
import { IDENTITY_RPC_METHODS } from '@gyblos/identity/constants';

import { acceptanceAssert } from './errors.js';
import {
  registryAccountJson,
  type RegistryAccount,
} from './identity-registry-accounts.js';
import { REGISTRY_FIXTURE } from './identity-registry-constants.js';

interface RegistryCall {
  id: string;
  method: string;
  params: unknown[];
}
export async function registryReadCall(
  request: IncomingMessage,
): Promise<RegistryCall> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    acceptanceAssert(size <= REGISTRY_FIXTURE.requestBytes);
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
  acceptanceAssert(parsed && typeof parsed === 'object');
  acceptanceAssert('jsonrpc' in parsed && parsed.jsonrpc === '2.0');
  acceptanceAssert('id' in parsed && typeof parsed.id === 'string');
  acceptanceAssert('method' in parsed && typeof parsed.method === 'string');
  acceptanceAssert('params' in parsed && Array.isArray(parsed.params));
  return { id: parsed.id, method: parsed.method, params: parsed.params };
}
function matches(data: Uint8Array, filter: unknown) {
  acceptanceAssert(filter && typeof filter === 'object' && 'memcmp' in filter);
  const item = filter.memcmp;
  acceptanceAssert(item && typeof item === 'object');
  acceptanceAssert('offset' in item && typeof item.offset === 'number');
  acceptanceAssert(Number.isSafeInteger(item.offset) && item.offset >= 0);
  acceptanceAssert('bytes' in item && typeof item.bytes === 'string');
  const bytes = getBase58Encoder().encode(item.bytes);
  const window = data.subarray(item.offset, item.offset + bytes.length);
  return (
    window.length === bytes.length &&
    window.every((byte, index) => byte === bytes[index])
  );
}
function programAccounts(accounts: RegistryAccount[], params: unknown[]) {
  const options = params[1];
  acceptanceAssert(
    options && typeof options === 'object' && 'filters' in options,
  );
  acceptanceAssert(Array.isArray(options.filters));
  const filters: unknown[] = options.filters;
  return accounts
    .filter(
      (account) =>
        account.owner === params[0] &&
        filters.every((filter) => matches(account.data, filter)),
    )
    .map((account) => ({
      pubkey: account.address,
      account: registryAccountJson(account),
    }));
}
export function registryReadResult(
  call: RegistryCall,
  accounts: RegistryAccount[],
  oversized: boolean,
) {
  const context = { slot: REGISTRY_FIXTURE.slot };
  switch (call.method) {
    case 'getGenesisHash':
      return DEVNET_GENESIS;
    case 'getProgramAccounts':
      return oversized ? [] : programAccounts(accounts, call.params);
    case 'getMultipleAccounts': {
      const keys = call.params[0];
      acceptanceAssert(
        Array.isArray(keys) && keys.length <= REGISTRY_FIXTURE.maxBindings,
      );
      acceptanceAssert(keys.every((key) => typeof key === 'string'));
      return {
        context,
        value: keys.map((key) =>
          registryAccountJson(
            accounts.find((account) => account.address === key),
          ),
        ),
      };
    }
    default:
      return null;
  }
}
export function registryMethodAllowed(method: string) {
  return IDENTITY_RPC_METHODS.some((allowed) => allowed === method);
}
