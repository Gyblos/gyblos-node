// Isolated product seller worker; ephemeral role only, fake engine/finance, loopback discovery and private IPC.
import assert from 'node:assert/strict';

import { DEVNET_USDC } from '@gyblos/config';
import { ACCEPTANCE } from '@gyblos/lab-harness/acceptance/constants';
import { receiptNativeBinding } from '@gyblos/lab-harness/acceptance/receipt-native';
import { assertAcceptanceTempBase } from '@gyblos/lab-harness/acceptance/workspace';
import { createNode } from '@gyblos/node';
import { setupRole } from '@gyblos/node/roles';
import { OFFER_PRICING_KINDS, P2P_ROLES } from '@gyblos/protocol/constants';
import {
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';
import { isMain } from '@gyblos/runtime';

import { HTTP_MULTI_METHODS } from './http-multiseller-constants';
import { httpMultiSellerPayments } from './http-multiseller-finance';
import { httpMultiText } from './http-multiseller-http';
import { httpMultiIpc } from './http-multiseller-ipc';
import { paidSellerConfiguration } from './paid-acceptance-config';
import { paidAcceptanceEngine } from './paid-acceptance-engine';

async function main() {
  assertAcceptanceTempBase(process.cwd());
  assert.equal(process.cwd(), process.env.GYBLOS_HOME);
  let external = 0;
  let blockedAck = false;
  const engine = paidAcceptanceEngine();
  const binding = receiptNativeBinding({ calls: engine.attempts });
  let role: Awaited<ReturnType<typeof setupRole>> | undefined;
  let buyerNodeId = '';
  let label = 0;
  let indexUrl = '';
  let seller: ReturnType<typeof createNode> | undefined;
  const localFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== new URL(indexUrl).origin ||
      !url.pathname.startsWith('/v1/')
    ) {
      external++;
      throw new Error('External I/O forbidden');
    }
    return localFetch(request);
  };
  const stop = async () => {
    engine.release();
    await seller?.stop();
    seller = undefined;
    await binding.close();
  };
  const ipc = httpMultiIpc(process, async (method, params) => {
    switch (method) {
      case HTTP_MULTI_METHODS.INIT: {
        const row = controlObject(params, ['buyerNodeId', 'indexUrl', 'label']);
        assert.ok(row.label === 0 || row.label === 1);
        label = Number(row.label);
        buyerNodeId = controlText(row.buyerNodeId);
        indexUrl = controlText(row.indexUrl);
        process.env.GYBLOS_RELAY_ONLY = '0';
        role = await setupRole({ role: P2P_ROLES.SELLER, mint: DEVNET_USDC });
        assert.equal(role.role, P2P_ROLES.SELLER);
        return role;
      }
      case HTTP_MULTI_METHODS.START: {
        assert.ok(role);
        await paidSellerConfiguration(OFFER_PRICING_KINDS.PAID);
        const { readFile, writeFile } = await import('node:fs/promises');
        const path = process.env.GYBLOS_CONFIG!;
        const config = await readFile(path, 'utf8');
        await writeFile(path, config.replace(ACCEPTANCE.baseUrl, indexUrl));
        seller = createNode({
          bind: binding.bind,
          createEngine: () => {
            const prepared = engine.create();
            const generate = prepared.engine.generate;
            return {
              ...prepared,
              engine: {
                ...prepared.engine,
                generate: async (input) => ({
                  ...(await generate(input)),
                  text: httpMultiText(label),
                }),
              },
            };
          },
          payments: () =>
            httpMultiSellerPayments(role!, buyerNodeId, ipc, () => blockedAck),
        });
        await seller.start();
        return { directAddresses: binding.directAddresses() };
      }
      case HTTP_MULTI_METHODS.SIGN: {
        assert.ok(
          Array.isArray(params) &&
            params.length <= 4096 &&
            params.every(
              (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
            ),
        );
        return [...(await binding.nodeSigner(Uint8Array.from(params)))];
      }
      case HTTP_MULTI_METHODS.HOLD:
        engine.hold();
        return null;
      case HTTP_MULTI_METHODS.RELEASE:
        engine.release();
        return null;
      case HTTP_MULTI_METHODS.ACK:
        assert.equal(typeof params, 'boolean');
        blockedAck = params === true;
        return null;
      case HTTP_MULTI_METHODS.HEALTH:
        return {
          generations: engine.attempts(),
          cancellations: engine.cancellations(),
          external,
        };
      case HTTP_MULTI_METHODS.STOP:
        await stop();
        assert.equal(external, 0);
        return null;
      default:
        assert.fail('Unexpected seller command');
    }
  });
  process.once('disconnect', () => {
    void stop().finally(() => {
      ipc.close();
      globalThis.fetch = localFetch;
    });
  });
  await ipc.call(HTTP_MULTI_METHODS.HELLO);
}
if (isMain(import.meta.url))
  void main().catch(() => {
    process.exitCode = 1;
    process.disconnect?.();
  });
